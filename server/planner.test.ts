import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore } from "./task-store.ts";
import { openDatabase } from "./database.ts";
import { nextDate, localMinute } from "../shared/planner.ts";
import { bulkPreviews } from "./planner.ts";
async function fixture(t: TestContext, legacy?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "planner-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.json");
  if (legacy) await writeFile(file, JSON.stringify(legacy));
  const db = openDatabase(dir);
  t.after(() => db.close());
  const store = createTaskStore(db, () => new Date("2026-01-30T10:00:00Z"));
  return { file, store };
}
test("旧清单原子迁移，移动父任务时同步移动所有子项，删除清单保留任务", async (t) => {
  const old = { id: "legacy", done: false, title: "报告", extension: 42 };
  const { file, store } = await fixture(t, [old]);
  assert.deepEqual(store.list(), [old]);
  assert.equal(await readFile(file, "utf8"), JSON.stringify([old]));
  const list = store.editList(null, "工作");
  const child = store.create("核对", { parentId: "legacy" });
  const grandchild = store.create("数据", { parentId: child.id });
  store.update("legacy", { listId: list });
  assert.ok(store.list().every((t) => t.listId === list));
  assert.throws(() => store.update("legacy", { parentId: grandchild.id }));
  store.editList(list, null);
  assert.equal(store.list().length, 3);
  assert.equal(store.list()[0].extension, 42);
  assert.ok(store.list().every((t) => !t.listId));
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
