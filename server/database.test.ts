import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.ts";
import { createTaskStore } from "./task-store.ts";
import { openConversation } from "./conversation.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "planner-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("startup ignores old JSON files and persists tasks and chat only in SQLite", (t) => {
  const dir = fixture(t);
  const files = {
    "tasks.json": '[{"id":"old","title":"旧任务","done":false}]',
    "tasks.json.chat.json": "invalid",
    "tasks.order.json": "[]",
    "tasks.bin.json": "[]",
  };
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(dir, file), contents);
  const db = openDatabase(dir);
  const store = createTaskStore(db);
  assert.deepEqual(store.list(), []);
  const task = store.create("新任务");
  const chat = openConversation(db);
  assert.deepEqual(chat.read(), { revision: 0, pending: false, messages: [] });
  chat.begin(0, "请记下新任务");
  chat.appendReply(1, true, "已记下");
  const history = chat.read();
  db.close();

  const reopened = openDatabase(dir);
  t.after(() => reopened.close());
  assert.deepEqual(createTaskStore(reopened).list(), [task]);
  assert.deepEqual(openConversation(reopened).read(), history);
  assert.equal(statSync(join(dir, "planner.sqlite")).mode & 0o777, 0o600);
  for (const [file, contents] of Object.entries(files))
    assert.equal(readFileSync(join(dir, file), "utf8"), contents);
});
test("an unrecognized database causes startup to fail", (t) => {
  const dir = fixture(t);
  const db = new DatabaseSync(join(dir, "planner.sqlite"));
  db.exec("CREATE TABLE unrelated(x TEXT); PRAGMA user_version=1");
  db.close();
  assert.throws(() => openDatabase(dir), /Unrecognized/);
});

test("opens a version 1 planner and adds the bin without changing its tasks", (t) => {
  const dir = fixture(t);
  const db = openDatabase(dir);
  const task = createTaskStore(db).create("历史任务");
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'revision_*'")
    .all())
    db.exec("DROP TRIGGER " + row.name);
  db.exec("DROP TABLE planner_revision");
  db.exec("ALTER TABLE conversation DROP COLUMN active_question_seq");
  db.exec("ALTER TABLE messages DROP COLUMN created_tasks");
  db.exec("ALTER TABLE messages DROP COLUMN presentation");
  db.exec(
    "DROP TRIGGER remember_creation; DROP TABLE task_creation; DROP TABLE task_bin; ALTER TABLE messages DROP COLUMN sort_change; ALTER TABLE conversation DROP COLUMN approval_mode; ALTER TABLE conversation DROP COLUMN approval; PRAGMA user_version=1",
  );
  db.close();
  const migrated = openDatabase(dir);
  assert.deepEqual(createTaskStore(migrated).list(), [task]);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM task_bin").get()?.n, 0);
  migrated.close();
});
