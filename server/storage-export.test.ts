import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, readConversation, readPlannerDocument } from "./database.ts";
import { createTaskStore } from "./task-store.ts";
import { openConversation } from "./conversation.ts";
import { deadlineQuestion } from "./chat-questions.ts";
import { exportStorage } from "./storage-export.ts";

test("rollback export preserves post-cutover data and refuses an existing destination", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rollback-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "rollback");
  assert.throws(() => exportStorage(dir, target));
  const db = openDatabase(dir);
  const tasks = createTaskStore(db);
  tasks.initializeZone("Asia/Singapore");
  const listId = tasks.editList(null, "工作");
  const task = tasks.create("周报", {
    listId,
    repeat: "weekly",
    dueDate: "2030-01-02",
    reminder: "2030-01-02T08:00",
    tags: ["工作"],
  });
  tasks.update(task.id, { done: true });
  const next = tasks.list().find((item) => !item.done)!;
  tasks.remove(next.id);
  const [deleted] = tasks.bin();
  const parent = tasks.create("采购");
  tasks.reorder([task.id, parent.id], [parent.id, task.id]);
  tasks.create("米", { parentId: parent.id, notes: "留收据" });
  const chat = openConversation(db);
  chat.begin(0, "帮我记下采购");
  chat.appendReply(
    1,
    true,
    "安排在哪一天？",
    undefined,
    deadlineQuestion(tasks.snapshot(), parent.id),
  );
  const planner = readPlannerDocument(db),
    history = chat.read();
  db.close();
  const existing = join(dir, "existing");
  mkdirSync(existing);
  assert.throws(() => exportStorage(dir, existing), /EEXIST/);
  assert.deepEqual(readdirSync(existing), []);
  exportStorage(dir, target);
  for (const file of ["tasks.json", "tasks.json.chat.json"])
    assert.equal(statSync(join(target, file)).mode & 0o777, 0o600);
  assert.throws(() => exportStorage(dir, target), /EEXIST/);
  const imported = openDatabase(target);
  assert.deepEqual(readPlannerDocument(imported), planner);
  assert.deepEqual(readConversation(imported), history);
  const restored = createTaskStore(imported);
  assert.deepEqual(restored.bin(), [deleted]);
  assert.ok(restored.restore(next.id, deleted.deletedAt));
  assert.deepEqual(
    restored
      .listByCreation()
      .slice(0, 3)
      .map((t) => t.id),
    [task.id, next.id, parent.id],
  );
  assert.deepEqual(
    restored.list().find((item) => item.id === next.id),
    next,
  );
  restored.update(next.id, { done: true });
  assert.ok(restored.list().some((item) => !item.done && item.seriesId === next.seriesId));
  imported.close();
});
