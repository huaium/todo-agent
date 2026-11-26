import { deepStrictEqual } from "node:assert";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { conversationSchema, type ChatMessage, type Conversation } from "../shared/chat.ts";
import { frequencies, inbox, type PlannerTask, type Planner } from "../shared/planner.ts";

const taskSchema = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const tasksSchema = z.array(taskSchema);
const plannerSchema = z.object({
  version: z.literal(1),
  timeZone: z.string().nullable(),
  lists: z.array(z.object({ id: z.string(), name: z.string() })),
  tasks: tasksSchema,
  series: z.record(
    z.string(),
    z.object({ anchor: z.string(), frequency: z.enum(frequencies), template: taskSchema }),
  ),
});
export type Series = {
  anchor: string;
  frequency: (typeof frequencies)[number];
  template: PlannerTask;
};
export type PlannerDocument = Planner & { version: 1; series: Record<string, Series> };
export const binRetentionMs = 30 * 24 * 60 * 60 * 1000;
const binSchema = z.array(
  z.object({
    task: taskSchema,
    deletedAt: z.number().int(),
    series: plannerSchema.shape.series.valueType.nullable(),
  }),
);
const binTable = `
  CREATE TABLE task_bin(id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), series TEXT CHECK(series IS NULL OR json_valid(series))) STRICT;
  CREATE INDEX bin_deletion ON task_bin(deleted_at);
`;

export function readBinBackup(db: DatabaseSync, now = Date.now()): z.infer<typeof binSchema> {
  if (db.prepare("PRAGMA user_version").get()?.user_version === 1) return [];
  return db
    .prepare(
      "SELECT payload,deleted_at,series FROM task_bin WHERE deleted_at>? ORDER BY deleted_at,id",
    )
    .all(now - binRetentionMs)
    .map((row) => ({
      task: JSON.parse(String(row.payload)),
      deletedAt: Number(row.deleted_at),
      series: row.series === null ? null : JSON.parse(String(row.series)),
    }));
}

export function transaction<T>(
  db: DatabaseSync,
  work: () => T,
  mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE",
): T {
  db.exec("BEGIN " + mode);
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function readLegacy<T>(path: string, empty: T, decode: (value: unknown) => T): T {
  if (!existsSync(path)) return empty;
  try {
    return decode(JSON.parse(readFileSync(path, "utf8")));
  } catch (cause) {
    throw new Error("Cannot import " + path, { cause });
  }
}

function emptyPlanner(): PlannerDocument {
  return {
    version: 1,
    timeZone: null,
    lists: [{ id: inbox, name: "收件箱" }],
    tasks: [],
    series: {},
  };
}

function emptyChat(): Conversation {
  return { revision: 0, pending: false, messages: [] };
}

export function readLegacyFiles(directory: string) {
  const empty = emptyPlanner();
  const planner = readLegacy(join(directory, "tasks.json"), empty, (value) => {
    if (Array.isArray(value)) {
      const tasks = tasksSchema.parse(value);
      deepStrictEqual(tasks, value);
      return { ...empty, tasks };
    }
    const parsed = plannerSchema.parse(value);
    deepStrictEqual(parsed, value);
    return parsed;
  });
  const chat = readLegacy<Conversation>(
    join(directory, "tasks.json.chat.json"),
    emptyChat(),
    (value) => {
      const parsed = conversationSchema.parse(value);
      // Validate legacy input without trimming stored message content during import.
      const raw = value as Conversation;
      parsed.messages.forEach((message, i) => {
        message.content = raw.messages[i].content;
      });
      deepStrictEqual(parsed, value);
      return parsed;
    },
  );
  const bin = readLegacy(join(directory, "tasks.bin.json"), [], (value) => binSchema.parse(value));
  const fallbackOrder = [...planner.tasks.map((t) => t.id), ...bin.map((entry) => entry.task.id)];
  const creationOrder = readLegacy(join(directory, "tasks.order.json"), fallbackOrder, (value) =>
    z.array(z.string()).parse(value),
  );
  return { planner, chat, bin, creationOrder };
}

function hasLegacyFiles(directory: string) {
  return ["tasks.json", "tasks.json.chat.json", "tasks.bin.json", "tasks.order.json"].some((file) =>
    existsSync(join(directory, file)),
  );
}

export function importLegacyDatabase(directory: string) {
  const filename = join(directory, "planner.sqlite");
  if (existsSync(filename)) throw new Error("Planner database already exists: " + filename);
  if (!hasLegacyFiles(directory)) throw new Error("No legacy planner files in " + directory);
  const snapshot = readLegacyFiles(directory);
  const ids = [
    ...snapshot.planner.tasks.map((t) => t.id),
    ...snapshot.bin.map((entry) => entry.task.id),
  ];
  const current = new Set(ids);
  const saved = new Set(snapshot.creationOrder);
  if (current.size !== ids.length || saved.size !== snapshot.creationOrder.length)
    throw new Error("Duplicate task ID in legacy planner or creation order");
  // Older versions edit tasks without updating the exported creation-order file.
  snapshot.creationOrder = [
    ...snapshot.creationOrder.filter((id) => current.has(id)),
    ...ids.filter((id) => !saved.has(id)),
  ];
  publishDatabase(directory, filename, snapshot);
}

const creationSchema = `
  CREATE TABLE task_creation(seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE) STRICT;
  INSERT INTO task_creation(id) SELECT id FROM tasks ORDER BY position;
  INSERT INTO task_creation(id) SELECT id FROM task_bin ORDER BY deleted_at,id;
  CREATE TRIGGER remember_creation AFTER INSERT ON tasks BEGIN
    INSERT OR IGNORE INTO task_creation(id) VALUES(NEW.id);
  END;
  CREATE TRIGGER forget_creation AFTER DELETE ON task_bin WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE id=OLD.id) BEGIN
    DELETE FROM task_creation WHERE id=OLD.id;
  END;
`;
function trackPlannerChanges(db: DatabaseSync) {
  db.exec(
    "CREATE TABLE planner_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL) STRICT; INSERT INTO planner_revision VALUES(1,0)",
  );
  for (const table of ["tasks", "lists", "task_bin", "settings"])
    for (const event of ["INSERT", "UPDATE", "DELETE"])
      db.exec(`CREATE TRIGGER revision_${table}_${event} AFTER ${event} ON ${table}
        BEGIN UPDATE planner_revision SET revision=revision+1 WHERE id=1; END;`);
  db.exec("PRAGMA user_version=6");
}
export function readCreationOrder(db: DatabaseSync, now: number): string[] {
  if (Number(db.prepare("PRAGMA user_version").get()?.user_version) < 5)
    return [
      ...readTasks(db).map((t) => t.id),
      ...readBinBackup(db, now).map((entry) => entry.task.id),
    ];
  return db
    .prepare(`SELECT id FROM task_creation WHERE id IN (SELECT id FROM tasks UNION ALL
    SELECT id FROM task_bin WHERE deleted_at>?) ORDER BY seq`)
    .all(now - binRetentionMs)
    .map((row) => String(row.id));
}

export function readTasks(db: DatabaseSync): PlannerTask[] {
  return db
    .prepare("SELECT payload FROM tasks ORDER BY position")
    .all()
    .map((r) => JSON.parse(String(r.payload)));
}
export function readPlanner(db: DatabaseSync): Planner {
  const settings = db.prepare("SELECT time_zone FROM settings WHERE id=1").get();
  if (!settings) throw new Error("Missing planner settings");
  return {
    timeZone: settings.time_zone as string | null,
    lists: db
      .prepare("SELECT id,name FROM lists ORDER BY position")
      .all()
      .map((r) => ({ id: String(r.id), name: String(r.name) })),
    tasks: readTasks(db),
  };
}
export function readPlannerDocument(db: DatabaseSync): PlannerDocument {
  const series = Object.fromEntries(
    db
      .prepare("SELECT id,payload FROM series")
      .all()
      .map((r) => [r.id, JSON.parse(String(r.payload))]),
  );
  return { version: 1, ...readPlanner(db), series };
}
export function chatState(db: DatabaseSync): Omit<Conversation, "messages"> {
  const r = db.prepare("SELECT * FROM conversation WHERE id=1").get();
  if (!r) throw new Error("Missing conversation state");
  return {
    revision: Number(r.revision),
    pending: !!r.pending,
    ...((r.approval_mode === "cautious" || r.approval_mode === "allow") && {
      approvalMode: r.approval_mode,
    }),
    ...(typeof r.approval === "string" && { approval: JSON.parse(r.approval) }),
    ...(r.preview !== null && { preview: JSON.parse(String(r.preview)) }),
  };
}
export function readMessages(db: DatabaseSync, latest?: number): ChatMessage[] {
  const fields = "SELECT * FROM messages ORDER BY seq";
  const rows =
    latest === undefined
      ? db.prepare(fields).all()
      : db
          .prepare(fields + " DESC LIMIT ?")
          .all(latest)
          .reverse();
  return rows.map((r) => ({
    role: r.role as ChatMessage["role"],
    content: String(r.content),
    ...(r.question !== null && { question: JSON.parse(String(r.question)) }),
    ...(typeof r.sort_change === "string" && { sortChange: JSON.parse(r.sort_change) }),
    ...(typeof r.created_tasks === "string" && { createdTasks: JSON.parse(r.created_tasks) }),
  }));
}
export function readConversation(db: DatabaseSync): Conversation {
  return { ...chatState(db), messages: readMessages(db) };
}
export function insertMessage(db: DatabaseSync, message: ChatMessage) {
  db.prepare(
    "INSERT INTO messages(role,content,question,sort_change,created_tasks) VALUES(?,?,?,?,?)",
  ).run(
    message.role,
    message.content,
    JSON.stringify(message.question) ?? null,
    JSON.stringify(message.sortChange) ?? null,
    JSON.stringify(message.createdTasks) ?? null,
  );
}

const approvalColumns = `
  ALTER TABLE conversation ADD COLUMN approval_mode TEXT CHECK(approval_mode IN ('allow','cautious'));
  ALTER TABLE conversation ADD COLUMN approval TEXT CHECK(approval IS NULL OR json_valid(approval));
`;
const createdTasksColumn =
  "ALTER TABLE messages ADD COLUMN created_tasks TEXT CHECK(created_tasks IS NULL OR json_valid(created_tasks))";
const schema = `
  CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), time_zone TEXT) STRICT;
  CREATE TABLE lists(position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL) STRICT;
  CREATE TABLE tasks(position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE INDEX task_parent ON tasks(json_extract(payload,'$.parentId'));
  CREATE INDEX task_list ON tasks(json_extract(payload,'$.listId'));
  CREATE TABLE series(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE TABLE conversation(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1)), preview TEXT) STRICT;
  CREATE TABLE messages(seq INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, question TEXT, sort_change TEXT) STRICT;
`;
function publishDatabase(
  directory: string,
  filename: string,
  { planner, chat, bin, creationOrder }: ReturnType<typeof readLegacyFiles>,
) {
  const staging = mkdtempSync(join(directory, ".sqlite-import-"));
  const path = join(staging, "planner.sqlite");
  try {
    closeSync(openSync(path, "wx", 0o600));
    const db = new DatabaseSync(path);
    try {
      transaction(db, () => {
        db.exec(schema);
        db.exec(binTable);
        db.exec(creationSchema);
        const remember = db.prepare("INSERT INTO task_creation(id) VALUES(?)");
        for (const id of creationOrder) remember.run(id);
        db.exec(approvalColumns);
        db.exec(createdTasksColumn);
        db.prepare("INSERT INTO settings VALUES(1,?)").run(planner.timeZone);
        const list = db.prepare("INSERT INTO lists(id,name) VALUES(?,?)");
        for (const l of planner.lists) list.run(l.id, l.name);
        const task = db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)");
        for (const t of planner.tasks) task.run(t.id, JSON.stringify(t));
        const archived = db.prepare(
          "INSERT INTO task_bin(id,deleted_at,payload,series) VALUES(?,?,?,?)",
        );
        for (const entry of bin) {
          if (entry.deletedAt <= Date.now() - binRetentionMs) {
            db.prepare("DELETE FROM task_creation WHERE id=?").run(entry.task.id);
            continue;
          }
          archived.run(
            entry.task.id,
            entry.deletedAt,
            JSON.stringify(entry.task),
            entry.series && JSON.stringify(entry.series),
          );
        }
        const series = db.prepare("INSERT INTO series VALUES(?,?)");
        for (const [id, s] of Object.entries(planner.series)) series.run(id, JSON.stringify(s));
        db.prepare("INSERT INTO conversation VALUES(1,?,?,?,?,?)").run(
          chat.revision,
          Number(chat.pending),
          JSON.stringify(chat.preview) ?? null,
          chat.approvalMode ?? null,
          JSON.stringify(chat.approval) ?? null,
        );
        for (const message of chat.messages) insertMessage(db, message);
        deepStrictEqual(readPlannerDocument(db), planner);
        deepStrictEqual(readConversation(db), chat);
        db.exec("PRAGMA application_id=1414480975");
        trackPlannerChanges(db);
        db.exec("PRAGMA user_version=7");
      });
    } finally {
      db.close();
    }
    // Publish only the closed, verified file. An existing database is never overwritten.
    linkSync(path, filename);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function openDatabase(directory: string, readOnly = false): DatabaseSync {
  const filename = join(directory, "planner.sqlite");
  if (!readOnly && !existsSync(filename)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (hasLegacyFiles(directory))
      throw new Error(
        "Legacy planner files found. Run npm run storage:import -- " +
          JSON.stringify(directory) +
          " before starting.",
      );
    publishDatabase(directory, filename, {
      planner: emptyPlanner(),
      chat: emptyChat(),
      bin: [],
      creationOrder: [],
    });
  }
  const db = new DatabaseSync(filename, { readOnly });
  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !== 1414480975 ||
      (version !== 1 &&
        version !== 2 &&
        version !== 3 &&
        version !== 4 &&
        version !== 5 &&
        version !== 6 &&
        version !== 7)
    )
      throw new Error("Unrecognized planner database or schema version: " + filename);
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("Invalid planner database: " + filename);
    if (version !== 7 && !readOnly)
      transaction(db, () => {
        if (db.prepare("PRAGMA user_version").get()?.user_version === 1) {
          db.exec(binTable);
          db.exec("PRAGMA user_version=2");
        }
        if (db.prepare("PRAGMA user_version").get()?.user_version === 2) {
          db.exec(approvalColumns);
          db.exec("PRAGMA user_version=3");
        }
        if (db.prepare("PRAGMA user_version").get()?.user_version === 3)
          db.exec("ALTER TABLE messages ADD COLUMN sort_change TEXT; PRAGMA user_version=4");
        if (db.prepare("PRAGMA user_version").get()?.user_version === 4) {
          db.exec(creationSchema);
          db.exec("PRAGMA user_version=5");
        }
        if (db.prepare("PRAGMA user_version").get()?.user_version === 5) trackPlannerChanges(db);
        if (db.prepare("PRAGMA user_version").get()?.user_version === 6) {
          db.exec(createdTasksColumn);
          db.exec("PRAGMA user_version=7");
        }
      });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
