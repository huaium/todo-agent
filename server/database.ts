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

export function readLegacyFiles(directory: string) {
  const empty: PlannerDocument = {
    version: 1,
    timeZone: null,
    lists: [{ id: inbox, name: "收件箱" }],
    tasks: [],
    series: {},
  };
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
    { revision: 0, pending: false, messages: [] },
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
  return { planner, chat };
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
  const r = db.prepare("SELECT revision,pending,preview FROM conversation WHERE id=1").get();
  if (!r) throw new Error("Missing conversation state");
  return {
    revision: Number(r.revision),
    pending: !!r.pending,
    ...(r.preview !== null && { preview: JSON.parse(String(r.preview)) }),
  };
}
export function readConversation(db: DatabaseSync): Conversation {
  const messages: ChatMessage[] = db
    .prepare("SELECT role,content,question FROM messages ORDER BY seq")
    .all()
    .map((r) => ({
      role: r.role as ChatMessage["role"],
      content: String(r.content),
      ...(r.question !== null && { question: JSON.parse(String(r.question)) }),
    }));
  return { ...chatState(db), messages };
}
export function insertMessage(db: DatabaseSync, message: ChatMessage) {
  db.prepare("INSERT INTO messages(role,content,question) VALUES(?,?,?)").run(
    message.role,
    message.content,
    JSON.stringify(message.question) ?? null,
  );
}

const schema = `
  CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), time_zone TEXT) STRICT;
  CREATE TABLE lists(position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL) STRICT;
  CREATE TABLE tasks(position INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE INDEX task_parent ON tasks(json_extract(payload,'$.parentId'));
  CREATE INDEX task_list ON tasks(json_extract(payload,'$.listId'));
  CREATE TABLE series(id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE TABLE conversation(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1)), preview TEXT) STRICT;
  CREATE TABLE messages(seq INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, question TEXT) STRICT;
`;
function importDatabase(directory: string, filename: string) {
  const { planner, chat } = readLegacyFiles(directory);
  const staging = mkdtempSync(join(directory, ".sqlite-import-"));
  const path = join(staging, "planner.sqlite");
  try {
    closeSync(openSync(path, "wx", 0o600));
    const db = new DatabaseSync(path);
    try {
      transaction(db, () => {
        db.exec(schema);
        db.prepare("INSERT INTO settings VALUES(1,?)").run(planner.timeZone);
        const list = db.prepare("INSERT INTO lists(id,name) VALUES(?,?)");
        for (const l of planner.lists) list.run(l.id, l.name);
        const task = db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)");
        for (const t of planner.tasks) task.run(t.id, JSON.stringify(t));
        const series = db.prepare("INSERT INTO series VALUES(?,?)");
        for (const [id, s] of Object.entries(planner.series)) series.run(id, JSON.stringify(s));
        db.prepare("INSERT INTO conversation VALUES(1,?,?,?)").run(
          chat.revision,
          Number(chat.pending),
          JSON.stringify(chat.preview) ?? null,
        );
        for (const message of chat.messages) insertMessage(db, message);
        deepStrictEqual(readPlannerDocument(db), planner);
        deepStrictEqual(readConversation(db), chat);
        db.exec("PRAGMA application_id=1414480975; PRAGMA user_version=1");
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
    importDatabase(directory, filename);
  }
  const db = new DatabaseSync(filename, { readOnly });
  try {
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !== 1414480975 ||
      db.prepare("PRAGMA user_version").get()?.user_version !== 1
    )
      throw new Error("Unrecognized planner database or schema version: " + filename);
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("Invalid planner database: " + filename);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
