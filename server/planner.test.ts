import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore } from "./task-store.ts";
import { openDatabase } from "./database.ts";
import { nextDate, localMinute } from "../shared/planner.ts";
import { bulkPreviews } from "./planner.ts";
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "planner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(dir);
  t.after(() => db.close());
  const store = createTaskStore(db, () => new Date("2026-01-30T10:00:00Z"));
  return { store };
}
test("manual ordering preserves hidden slots and rejects stale or invalid moves atomically", async (t) => {
  const { store } = await fixture(t);
  const [a, hidden, b, c] = ["a", "hidden", "b", "c"].map((title) => store.create(title));
  const previous = [a.id, b.id, c.id],
    ordered = [c.id, a.id, b.id];
  assert.ok(store.reorder(previous, ordered));
  assert.deepEqual(store.list(), [c, hidden, a, b]);
  assert.equal(store.reorder(previous, ordered), false);
  assert.throws(() => store.reorder(ordered, [a.id, a.id, c.id]));
  store.remove(a.id);
  assert.equal(store.reorder(ordered, previous), false);
  assert.deepEqual(store.list(), [c, hidden, b]);
});
test("relative moves promote a child, preserve its descendants, and reject cycles without changing order", async (t) => {
  const { store } = await fixture(t);
  const meeting = store.create("开会"),
    eggs = store.create("买鸡蛋", { parentId: meeting.id });
  const child = store.create("带袋子", { parentId: eggs.id });
  const other = store.create("开会");
  store.moveRelative(eggs.id, meeting.id, "before");
  assert.deepEqual(
    store.list().map((t) => t.id),
    [eggs.id, meeting.id, child.id, other.id],
  );
  assert.equal(store.list()[0].parentId, null);
  const before = store.list();
  assert.throws(() => store.moveRelative(eggs.id, child.id, "after"));
  assert.throws(() => store.moveRelative(eggs.id, "missing", "before"));
  assert.deepEqual(store.list(), before);
  store.moveRelative(meeting.id, child.id, "after");
  assert.equal(store.list().find((t) => t.id === meeting.id)?.parentId, eggs.id);
  assert.deepEqual(
    store
      .list()
      .filter((t) => t.parentId === eggs.id)
      .map((t) => t.id),
    [child.id, meeting.id],
  );
});
test("移动父任务时同步移动所有子项，删除清单保留任务", async (t) => {
  const { store } = await fixture(t);
  const parent = store.create("报告");
  const list = store.editList(null, "工作");
  const child = store.create("核对", { parentId: parent.id });
  const grandchild = store.create("数据", { parentId: child.id });
  store.update(parent.id, { listId: list });
  assert.ok(store.list().every((t) => t.listId === list));
  assert.throws(() => store.update(parent.id, { parentId: grandchild.id }));
  store.editList(list, null);
  assert.equal(store.list().length, 3);
  assert.ok(store.list().every((t) => !t.listId));
});
test("moving a completed task beside a pending subtask preserves both hierarchy and order", async (t) => {
  const { store } = await fixture(t);
  const parent = store.create("采购");
  const child = store.create("牛奶", { parentId: parent.id });
  const done = store.create("取件");
  store.update(done.id, { done: true });
  const before = store.list();
  assert.throws(() => store.moveRelative(done.id, child.id, "before"), /待办和已完成/);
  assert.deepEqual(store.list(), before);
});
test("bin restores only the current deletion before the exact 30-day cutoff and purges on restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "planner-bin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let millis = Date.parse("2026-03-01T12:34:56Z");
  const clock = () => new Date(millis);
  const db = openDatabase(dir);
  const store = createTaskStore(db, clock);
  const listId = store.editList(null, "工作");
  const task = store.create("周报", { listId, notes: "保留草稿", reminder: "2026-03-01T09:00" });
  assert.ok(store.remove(task.id));
  assert.equal(store.remove(task.id), false);
  const [entry] = store.bin();
  assert.deepEqual(store.snapshot().tasks, []);
  assert.equal(store.update(task.id, { done: true }), undefined);
  assert.equal(store.remind(task.id, task.reminder!, "claim"), false);
  store.editList(listId, null);
  millis += 30 * 86400000 - 1;
  assert.ok(store.restore(task.id, entry.deletedAt));
  assert.equal(store.list()[0].listId, undefined);
  assert.equal(store.list()[0].notes, task.notes);
  store.remove(task.id);
  assert.equal(store.restore(task.id, entry.deletedAt), false);
  const [again] = store.bin();
  millis = again.deletedAt + 30 * 86400000;
  assert.deepEqual(store.bin(), []);
  db.close();
  const reopened = openDatabase(dir);
  t.after(() => reopened.close());
  const afterRestart = createTaskStore(reopened, clock);
  afterRestart.purgeExpired();
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM task_bin").get()?.n, 0);
  assert.equal(afterRestart.restore(task.id, again.deletedAt), false);
});
test("周期完成可重试、保持月末锚点及提醒偏移，仅本次的修改不传播", async (t) => {
  const { store } = await fixture(t);
  store.initializeZone("Asia/Singapore");
  const task = store.create("结算", {
    dueDate: "2026-01-31",
    repeat: "monthly",
    reminder: "2026-01-30T15:00",
  });
  store.update(task.id, { done: true });
  store.update(task.id, { done: true });
  assert.equal(store.list().length, 2);
  const feb = store.list()[1];
  assert.equal(feb.dueDate, "2026-02-28");
  assert.equal(feb.reminder, "2026-02-27T15:00");
  store.update(feb.id, { title: "二月结算" });
  store.update(feb.id, { done: true });
  assert.equal(store.list()[2].dueDate, "2026-03-31");
  assert.equal(store.list()[2].title, "结算");
  const march = store.list()[2];
  store.update(march.id, { reminder: "2026-03-29T11:00" }, "future");
  store.update(march.id, { done: true });
  assert.equal(store.list()[3].reminder, "2026-04-28T11:00");
  assert.equal(nextDate("2028-02-29", "yearly", "2031-02-28"), "2032-02-29");
  assert.equal(nextDate("2020-01-03", "weekly", "2026-01-30"), "2026-02-06");
});
test("adding and clearing a deadline preserves an independent reminder and its delivery state", async (t) => {
  const { store } = await fixture(t);
  const reminder = "2026-01-30T08:00";
  const { id } = store.create("采购", { reminder });
  assert.ok(store.remind(id, reminder, "claim"));
  for (const dueDate of ["2026-01-31", null]) {
    const updated = store.update(id, { dueDate })!;
    assert.equal(updated.reminder, reminder);
    assert.equal(updated.notifiedAt, reminder);
  }
  assert.equal(store.update(id, { reminder: null })!.reminder, null);
});
test("changing a repeat rule requires future scope and cancellation stops the next occurrence", async (t) => {
  const { store } = await fixture(t);
  const task = store.create("例会", { dueDate: "2026-01-31", repeat: "daily" });
  assert.throws(() => store.update(task.id, { repeat: null }), /后续/);
  assert.throws(() => store.update(task.id, { repeat: "weekly" }, "one"), /后续/);
  assert.deepEqual(store.list(), [task]);
  store.update(task.id, { repeat: "weekly" }, "future");
  store.update(task.id, { done: true });
  const next = store.list()[1];
  assert.equal(next.dueDate, "2026-02-07");
  store.update(next.id, { repeat: null }, "future");
  store.update(next.id, { done: true });
  assert.equal(store.list().length, 2);
});
test("提醒只投递一次，稍后提醒跨标签页共享，过期批量预览不产生部分写入", async (t) => {
  const { store } = await fixture(t);
  store.initializeZone("Asia/Singapore");
  const at = "2026-01-30T17:00";
  const a = store.create("采购", { reminder: at });
  const b = store.create("牛奶");
  assert.equal(store.remind(a.id, at, "claim"), true);
  assert.equal(store.remind(a.id, at, "claim"), false);
  assert.equal(store.remind(a.id, at, "snooze"), true);
  assert.equal(store.list()[0].snoozeUntil, "2026-01-30T18:10");
  const bulk = bulkPreviews(store);
  const draft = bulk.preview([a.id, b.id], "2026-02-01");
  store.update(b.id, { done: true });
  assert.throws(() => bulk.confirm(draft.token));
  assert.equal(store.list()[0].dueDate, undefined);
  const fresh = bulk.preview([a.id], "2026-02-01");
  bulk.confirm(fresh.token);
  assert.equal(store.list()[0].dueDate, "2026-02-01");
  assert.throws(() => bulk.confirm(fresh.token));
  assert.equal(
    localMinute(new Date("2026-02-01T00:00:00Z"), "America/Los_Angeles"),
    "2026-01-31T16:00",
  );
});
