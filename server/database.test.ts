import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, readConversation, readPlannerDocument } from "./database.ts";

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
  assert.throws(() => openDatabase(dir), /UNIQUE/);
  assert.ok(!existsSync(join(dir, "planner.sqlite")));
  writeFileSync(path, JSON.stringify([task]));
  writeFileSync(join(dir, "tasks.json.chat.json"), "{");
  assert.throws(() => openDatabase(dir), /tasks.json.chat.json/);
  assert.ok(!existsSync(join(dir, "planner.sqlite")));
  writeFileSync(
    join(dir, "tasks.json.chat.json"),
    JSON.stringify({ revision: 0, pending: false, messages: [] }),
  );
  const db = openDatabase(dir);
  assert.deepEqual(readPlannerDocument(db).tasks, [task]);
  db.exec("PRAGMA user_version=2");
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
