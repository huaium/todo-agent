import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  importLegacyDatabase,
  openDatabase,
  readConversation,
  readCreationOrder,
  readPlannerDocument,
} from "./database.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "planner-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("imports either or both sources once, retaining order, fields and source bytes", (t) => {
  const task = { id: "b", title: "B", done: false, dueDate: null, custom: { color: "red" } };
  const older = [task, { id: "a", title: "A", done: true }];
  const chat = {
    revision: 19,
    pending: false,
    messages: [{ role: "assistant", content: " 保存记录 " }],
  };
  for (const [hasTasks, hasChat] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const dir = fixture(t);
    const tasksPath = join(dir, "tasks.json");
    const chatPath = join(dir, "tasks.json.chat.json");
    if (hasTasks) writeFileSync(tasksPath, JSON.stringify(older));
    if (hasChat) writeFileSync(chatPath, JSON.stringify(chat));
    if (hasTasks || hasChat) {
      assert.throws(() => openDatabase(dir), /storage:import/);
      assert.equal(existsSync(join(dir, "planner.sqlite")), false);
      importLegacyDatabase(dir);
    } else {
      assert.throws(() => importLegacyDatabase(dir), /No legacy/);
    }
    const db = openDatabase(dir);
    assert.deepEqual(readPlannerDocument(db).tasks, hasTasks ? older : []);
    assert.deepEqual(
      readConversation(db),
      hasChat ? chat : { revision: 0, pending: false, messages: [] },
    );
    db.close();
    assert.equal(statSync(join(dir, "planner.sqlite")).mode & 0o777, 0o600);
    if (hasTasks) assert.equal(readFileSync(tasksPath, "utf8"), JSON.stringify(older));
    if (hasChat) assert.equal(readFileSync(chatPath, "utf8"), JSON.stringify(chat));
    writeFileSync(tasksPath, "ignored after cutover");
    assert.throws(() => importLegacyDatabase(dir), /already exists/);
    const reopened = openDatabase(dir);
    assert.deepEqual(readPlannerDocument(reopened).tasks, hasTasks ? older : []);
    reopened.close();
  }
});
test("a failed import publishes neither store; correcting the source allows retry", (t) => {
  const dir = fixture(t),
    path = join(dir, "tasks.json");
  const task = { id: "a", title: "A", done: false };
  writeFileSync(path, JSON.stringify([task, task]));
  assert.throws(() => importLegacyDatabase(dir), /Duplicate task ID/);
  assert.ok(!existsSync(join(dir, "planner.sqlite")));
  writeFileSync(path, JSON.stringify([task]));
  writeFileSync(join(dir, "tasks.json.chat.json"), "{");
  assert.throws(() => importLegacyDatabase(dir), /tasks.json.chat.json/);
  assert.ok(!existsSync(join(dir, "planner.sqlite")));
  writeFileSync(
    join(dir, "tasks.json.chat.json"),
    JSON.stringify({ revision: 0, pending: false, messages: [] }),
  );
  importLegacyDatabase(dir);
  const db = openDatabase(dir);
  assert.deepEqual(readPlannerDocument(db).tasks, [task]);
  db.exec("PRAGMA user_version=99");
  db.close();
  assert.throws(() => openDatabase(dir), /schema version/);
});
test("unrecognized database is never replaced with legacy JSON", (t) => {
  const dir = fixture(t);
  const db = new DatabaseSync(join(dir, "planner.sqlite"));
  db.exec("CREATE TABLE unrelated(x TEXT); PRAGMA user_version=1");
  db.close();
  assert.throws(() => openDatabase(dir), /Unrecognized/);
});

test("explicit import reconciles an old creation order with later edits and bin entries", (t) => {
  const dir = fixture(t);
  const task = (id: string) => ({ id, title: id, done: false });
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(["new", "b", "a"].map(task)));
  writeFileSync(
    join(dir, "tasks.bin.json"),
    JSON.stringify([{ task: task("archived"), deletedAt: Date.now(), series: null }]),
  );
  const order = join(dir, "tasks.order.json");
  writeFileSync(order, JSON.stringify(["a", "a"]));
  assert.throws(() => importLegacyDatabase(dir), /Duplicate/);
  writeFileSync(order, JSON.stringify(["gone", "a", "archived", "b"]));
  importLegacyDatabase(dir);
  const db = openDatabase(dir);
  t.after(() => db.close());
  assert.deepEqual(readCreationOrder(db, Date.now()), ["a", "archived", "b", "new"]);
  assert.deepEqual(
    readPlannerDocument(db).tasks.map((t) => t.id),
    ["new", "b", "a"],
  );
});

test("opens a version 1 planner and adds the bin without changing its tasks", (t) => {
  const dir = fixture(t);
  const task = { id: "before-bin", title: "历史任务", done: false };
  writeFileSync(join(dir, "tasks.json"), JSON.stringify([task]));
  importLegacyDatabase(dir);
  const db = openDatabase(dir);
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'revision_*'")
    .all())
    db.exec("DROP TRIGGER " + row.name);
  db.exec("DROP TABLE planner_revision");
  db.exec("ALTER TABLE messages DROP COLUMN created_tasks");
  db.exec(
    "DROP TRIGGER remember_creation; DROP TABLE task_creation; DROP TABLE task_bin; ALTER TABLE messages DROP COLUMN sort_change; ALTER TABLE conversation DROP COLUMN approval_mode; ALTER TABLE conversation DROP COLUMN approval; PRAGMA user_version=1",
  );
  db.close();
  const migrated = openDatabase(dir);
  assert.deepEqual(readPlannerDocument(migrated).tasks, [task]);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM task_bin").get()?.n, 0);
  migrated.close();
});
