import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createTaskStore } from "./task-store.ts";
import { openDatabase } from "./database.ts";
import { openConversation } from "./conversation.ts";
import { taskTools } from "./task-tools.ts";
import { candidate } from "./chat-questions.ts";
import { workspaceContext } from "./agent.ts";
import { bulkPreviews } from "./planner.ts";
import { ChatCapture } from "./chat-capture.ts";
import { ApprovalTurn } from "./chat-approval.ts";

test("canceling the second approval names the first saved task", async (t) => {
  const { store, port, chat } = await startTestApp(t);
  const message = "记下买茶和买盐";
  chat.setApprovalMode(0, "cautious");
  chat.begin(1, message);
  const capture = new ChatCapture(message);
  const turn = new ApprovalTurn(chat, store, 2, capture);
  const create = taskTools(port, store, undefined, undefined, undefined, undefined, capture).find(
    (tool) => tool.name === "createTask",
  )!;
  await turn.start(async () => {
    await create.execute("first", { title: "买茶" });
    await create.execute("second", { title: "买盐" });
    return { reply: "已记下。" };
  });
  await turn.decide(true);
  await turn.decide(false);
  assert.deepEqual(
    store.list().map((task) => task.title),
    ["买茶"],
  );
  assert.deepEqual(chat.read().messages.at(-1), {
    role: "assistant",
    content: "已添加「买茶」。\n已取消待审批的更改。",
  });
});

test("批量回执只包含本轮保存的任务，保留日期精度和单条任务的追问偏好", async (t) => {
  const { store, port } = await startTestApp(t);
  const capture = new ChatCapture("可留空，定时那件比较急。");
  const create = taskTools(port, store, undefined, undefined, undefined, undefined, capture).find(
    (tool) => tool.name === "createTask",
  )!;
  const finish = () => capture.finish(store, { reply: "已记下。" }, { interactive: true });
  store.create("已有任务");
  await create.execute("first", {
    title: "可留空",
    deadlineOptOutQuote: "可留空",
    details: { priority: "中" },
  });
  assert.equal(finish().question, undefined);
  await create.execute("rejected", { title: "" });
  assert.equal(finish().createdTasks, undefined);
  await create.execute("second", { title: "仅设日期", details: { dueDate: "2030-04-05" } });
  await create.execute("third", {
    title: "定时",
    details: { dueDate: "2030-04-06", dueTime: "09:00", priority: "高" },
    priorityQuote: "比较急",
  });
  assert.equal(store.list().find((task) => task.title === "可留空")!.priority, undefined);
  assert.equal(store.list().find((task) => task.title === "定时")!.priority, "高");
  const result = finish();
  assert.equal(result.question, undefined);
  assert.equal(result.reply, "已添加 3 项任务。1 项有具体时间，1 项仅设日期，1 项未设日期。");
  assert.deepEqual(
    result.createdTasks?.map((t) => [t.title, t.dueDate, t.dueTime]),
    [
      ["可留空", null, null],
      ["仅设日期", "2030-04-05", null],
      ["定时", "2030-04-06", "09:00"],
    ],
  );
  const single = new ChatCapture("再记一条取快递");
  const pickup = store.create("取快递");
  single.record(pickup.id, "可留空");
  const followup = single.finish(
    store,
    { reply: "已添加「取快递」，截止时间留空。" },
    { interactive: true },
  );
  assert.equal(followup.question?.kind, "deadline");
  assert.ok(followup.question?.kind === "deadline" && followup.question.task.id === pickup.id);
  assert.equal(
    single.finish(store, { reply: "已记下。" }, { interactive: true, keepReply: true }).question
      ?.kind,
    "deadline",
  );
});

async function startTestApp(
  t: TestContext,
  reply?: (messages: ChatMessage[]) => Promise<string>,
  now?: () => Date,
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = openDatabase(directory);
  t.after(() => db.close());
  const store = createTaskStore(db, now);
  const chat = openConversation(db);
  const app = createApp({ tasks: store, chat, reply });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  return { request, store, port, directory, chat, db };
}

test("批量删除只将确认时选中的已完成任务移入回收站，允许重试和恢复", async (t) => {
  const { request, store } = await startTestApp(t);
  const parent = store.create("准备会议");
  const child = store.create("检查投影", { parentId: parent.id });
  const pending = store.create("整理现场", { parentId: parent.id });
  const reopened = store.create("复核名单");
  const recurring = store.create("每日签到", { repeat: "daily", dueDate: "2030-01-01" });
  const completedIds = [parent.id, child.id, reopened.id, recurring.id];
  for (const id of completedIds) store.update(id, { done: true });
  store.update(reopened.id, { done: false });
  const later = store.create("新完成的任务");
  store.update(later.id, { done: true });
  assert.equal((await request("DELETE", "/api/planner/tasks", {})).status, 400);
  for (let i = 0; i < 2; i++)
    assert.equal((await request("DELETE", "/api/planner/tasks", { completedIds })).status, 204);
  const bin = store.bin();
  assert.deepEqual(bin.map((item) => item.id).sort(), [parent.id, child.id, recurring.id].sort());
  const snapshot = store.list();
  assert.ok(snapshot.some((task) => task.id === pending.id && !task.parentId));
  assert.ok(snapshot.some((task) => task.id === reopened.id && !task.done));
  assert.ok(snapshot.some((task) => task.id === later.id && task.done));
  assert.ok(snapshot.some((task) => task.title === recurring.title && !task.done));
  for (const id of [parent.id, child.id])
    assert.ok(store.restore(id, bin.find((item) => item.id === id)!.deletedAt));
  assert.equal(store.list().find((task) => task.id === child.id)?.parentId, parent.id);
});

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("stale autosaves return the current task without writing", async (t) => {
  const { store, request } = await startTestApp(t);
  const task = store.create("记录");
  const expectedVersion = createHash("sha256").update(JSON.stringify(task)).digest("hex");
  const path = "/api/planner/tasks/" + task.id;
  const first = await request("PATCH", path, { changes: { notes: "first" }, expectedVersion });
  assert.equal(first.status, 200);
  const second = await request("PATCH", path, { changes: { notes: "second" }, expectedVersion });
  assert.equal(second.status, 412);
  assert.deepEqual(second.body.current, first.body);
  assert.deepEqual(store.list(), [first.body]);
});

test("manual moves and bin restores preserve creation order in the public API", async (t) => {
  const { request, store } = await startTestApp(t);
  const a = store.create("A"),
    b = store.create("B");
  await request("POST", "/api/planner/tasks/order", {
    previous: [a.id, b.id],
    ordered: [b.id, a.id],
  });
  assert.deepEqual((await request("GET", "/api/planner")).body.tasks, [b, a]);
  assert.deepEqual((await request("GET", "/api/tasks")).body, [a, b]);
  store.remove(a.id);
  const c = store.create("C");
  store.restore(a.id, store.bin()[0].deletedAt);
  assert.deepEqual((await request("GET", "/api/tasks")).body, [a, b, c]);
});

test("planner sync skips unchanged snapshots and tracks writes, ordering, lists and the bin", async (t) => {
  const { request, store } = await startTestApp(t);
  let token = "";
  const sync = (bin = false) =>
    request("GET", "/api/planner/sync?bin=" + Number(bin) + "&after=" + encodeURIComponent(token));
  async function changed(bin = false) {
    const response = await sync(bin);
    assert.equal(response.status, 200);
    token = response.body.revision;
    assert.deepEqual(response.body.planner, store.snapshot());
    assert.deepEqual(response.body.bin, bin ? store.bin() : null);
    assert.equal((await sync(bin)).status, 204);
  }
  await changed();
  store.initializeZone("Asia/Singapore");
  await changed();
  const list = store.editList(null, "工作");
  await changed();
  const a = store.create("A", { listId: list }),
    b = store.create("B");
  await changed();
  store.update(a.id, { notes: "草稿" });
  await changed();
  store.reorder([a.id, b.id], [b.id, a.id]);
  await changed();
  store.remove(a.id);
  await changed(true);
  store.deleteBinItems([{ id: a.id, deletedAt: store.bin()[0].deletedAt }]);
  await changed(true);
});

test("relative movement rejects a changed anchor before promoting a child", async (t) => {
  const { store, request } = await startTestApp(t);
  const anchor = store.create("开会"),
    source = store.create("买鸡蛋", { parentId: anchor.id });
  const snapshot = store.snapshot();
  const expected = {
    source: candidate(snapshot, source.id)!.version,
    anchor: candidate(snapshot, anchor.id)!.version,
  };
  store.update(anchor.id, { title: "另一次会议" });
  assert.equal(
    (
      await request("POST", "/api/planner/tasks/order", {
        id: source.id,
        anchorId: anchor.id,
        side: "before",
        expected,
      })
    ).status,
    412,
  );
  assert.deepEqual(
    store.list().map((t) => [t.id, t.parentId]),
    [
      [anchor.id, undefined],
      [source.id, anchor.id],
    ],
  );
});
test("permanent deletion removes only the selected bin entry", async (t) => {
  const { store, request } = await startTestApp(t);
  const a = store.create("周报"),
    b = store.create("周报"),
    active = store.create("保留");
  store.remove(a.id);
  store.remove(b.id);
  const entry = store.bin().find((item) => item.id === a.id)!;
  const collection = "/api/planner/bin",
    path = collection + "/" + a.id;
  const body = { deletedAt: entry.deletedAt };
  assert.equal((await request("DELETE", collection, body)).status, 400);
  assert.equal((await request("DELETE", path)).status, 400);
  assert.equal((await request("DELETE", path, { deletedAt: entry.deletedAt - 1 })).status, 404);
  assert.equal(store.bin().length, 2);
  assert.equal((await request("DELETE", path, body)).status, 204);
  assert.equal((await request("DELETE", path, body)).status, 404);
  assert.equal((await request("POST", path + "/restore", body)).status, 404);
  const [other] = store.bin();
  assert.equal(other.id, b.id);
  assert.ok(store.restore(other.id, other.deletedAt));
  assert.deepEqual(store.list(), [active, b]);
});

test("清空回收站只永久删除确认过的记录，重试不影响后来删除的任务", async (t) => {
  let time = Date.now();
  const { store, request } = await startTestApp(t, undefined, () => new Date(time));
  const url = "/api/planner/bin";
  const kept = store.create("保留");
  const [a, b, restored, archivedAgain, later] = ["甲", "乙", "丙", "丁", "戊"].map((title) =>
    store.create(title),
  );
  for (const task of [a, b, restored, archivedAgain]) store.remove(task.id);
  const entries = store.bin().map(({ id, deletedAt }) => ({ id, deletedAt }));
  assert.ok(store.restore(restored.id, entries.find((e) => e.id === restored.id)!.deletedAt));
  assert.ok(
    store.restore(archivedAgain.id, entries.find((e) => e.id === archivedAgain.id)!.deletedAt),
  );
  for (const body of [{ entries: [] }, { entries: [{ id: a.id }] }])
    assert.equal((await request("DELETE", url, body)).status, 400);
  store.remove(later.id);
  time += 1000;
  store.remove(archivedAgain.id);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal((await request("DELETE", url, { entries })).status, 204);
  assert.deepEqual(
    store
      .bin()
      .map((e) => e.id)
      .sort(),
    [later.id, archivedAgain.id].sort(),
  );
  assert.deepEqual(
    store
      .list()
      .map((t) => t.id)
      .sort(),
    [kept.id, restored.id].sort(),
  );
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("模型工具通过任务 HTTP 接口读写，参数错误不改变清单", async (t) => {
  const { request, port, store } = await startTestApp(t);
  const tools = taskTools(port, store);
  const execute = async (name: string, args: unknown) =>
    (await tools.find((tool) => tool.name === name)!.execute("test-call", args)).details;
  await execute("createTask", { title: "买牛奶" });
  const [task] = (await request("GET", "/api/tasks")).body;
  assert.equal(task.title, "买牛奶");
  assert.ok("error" in Object(await execute("updateTask", "{")));
  assert.ok("error" in Object(await execute("updateTask", { id: task.id, changes: {} })));
  assert.deepEqual(await execute("listTasks", {}), [task]);
  assert.deepEqual(await execute("listTasks", { display: true }), { reply: "· 买牛奶（待办）" });
  await execute("updateTask", { id: task.id, changes: { done: true } });
  assert.equal(store.list()[0].done, true);
  await execute("deleteTask", { id: task.id });
  assert.deepEqual(await execute("listTasks", {}), []);
});

test("chat context stays compact, search pages exclude notes, and visible bulk previews cover all pages", async (t) => {
  const { store, port } = await startTestApp(t);
  const notes = "采购明细".repeat(500);
  const tasks = Array.from({ length: 27 }, (_, i) => store.create("记录" + i, { notes }));
  const view = { view: "已筛选", visibleIds: tasks.slice(1).map((t) => t.id), selectedId: null };
  const compact = JSON.stringify(workspaceContext(view));
  assert.ok(compact.length < 150 && !compact.includes(tasks[1].id));
  const bulk = bulkPreviews(store);
  let token = "";
  const tools = taskTools(
    port,
    store,
    (ids, date) => {
      const preview = bulk.preview(ids, date);
      token = preview.token;
      return preview;
    },
    undefined,
    undefined,
    view,
  );
  const run = async (name: string, args: object) =>
    (await tools.find((tool) => tool.name === name)!.execute("test", args)).details;
  const first = (await run("listTasks", { query: "采购", visible: true })) as {
    tasks: { id: string; notes?: string }[];
    nextOffset: number;
  };
  assert.deepEqual(
    first.tasks.map((t) => t.id),
    view.visibleIds.slice(0, 20),
  );
  assert.ok(first.tasks.every((task) => task.notes === undefined));
  assert.equal(first.nextOffset, 20);
  const rest = (await run("listTasks", {
    query: "采购",
    visible: true,
    offset: first.nextOffset,
  })) as { id: string }[];
  assert.deepEqual(
    rest.map((t) => t.id),
    view.visibleIds.slice(20),
  );
  const detail = (await run("readTaskDetails", { id: tasks[1].id })) as {
    notes: string;
    nextNoteOffset: number;
  };
  assert.equal(detail.notes, notes.slice(0, 1600));
  assert.equal(detail.nextNoteOffset, 1600);
  await run("previewReschedule", { visible: true, date: "2030-01-01" });
  bulk.confirm(token);
  assert.deepEqual(
    store
      .list()
      .filter((t) => t.dueDate === "2030-01-01")
      .map((t) => t.id),
    view.visibleIds,
  );
});

test("更新数据库中的任务时保留其他任务和扩展字段", async (t) => {
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  const { request, store, db } = await startTestApp(t);
  const insert = db.prepare("INSERT INTO tasks(id,payload) VALUES(?,?)");
  for (const task of [first, second]) insert.run(task.id, JSON.stringify(task));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(store.list(), [{ ...first, done: true }, second]);
});

test("小明的清单操作和稍后提醒与规划界面共享数据", async (t) => {
  const { port, store } = await startTestApp(t);
  const tools = taskTools(port, store);
  const run = async (name: string, args: object) =>
    (await tools.find((tool) => tool.name === name)!.execute("planner-test", args)).details;
  await run("manageList", { action: "create", name: "采购" });
  const list = store.snapshot().lists.find((l) => l.name === "采购")!;
  await run("manageList", { action: "rename", id: list.id, name: "购物" });
  await run("createTask", {
    title: "牛奶",
    details: { listId: list.id, reminder: "2025-01-01T09:00" },
  });
  const [task] = store.list();
  assert.equal(task.listId, list.id);
  assert.deepEqual(await run("snoozeReminder", { id: task.id }), { snoozed: task.id });
  assert.ok(store.list()[0].snoozeUntil);
  await run("manageList", { action: "delete", id: list.id });
  assert.equal(store.list()[0].id, task.id);
  assert.equal(store.list()[0].listId, undefined);
});

test("任务详情持久化，筛选到期子任务并保留已删除父任务的子项", async (t) => {
  const { request, port, store, directory } = await startTestApp(t);
  const tools = taskTools(port, store);
  const run = async (name: string, args: unknown) =>
    (await tools.find((tool) => tool.name === name)!.execute("test-call", args)).details;
  const parent = store.create("准备发布");
  const child = store.create("核对清单");
  const details = { dueDate: "2028-02-29", priority: "高", effort: "小", parentId: parent.id };
  assert.deepEqual(await run("setTaskDetails", { id: child.id, changes: details }), {
    ...child,
    ...details,
  });
  for (const changes of [
    { parentId: child.id },
    { parentId: "missing" },
    { dueDate: "2027-02-29" },
    { priority: "urgent" },
  ]) {
    assert.ok("error" in Object(await run("setTaskDetails", { id: parent.id, changes })));
  }
  assert.deepEqual(
    await run("listTasks", { dueDate: details.dueDate, done: false, parentId: parent.id }),
    [{ ...child, ...details }],
  );
  await run("setTaskDetails", { id: parent.id, changes: { dueDate: "2028-02-28" } });
  assert.deepEqual(await run("showTasksDue", { date: "2028-02-28" }), {
    reply: "2028-02-28 到期的未完成任务：\n· 准备发布（待办）",
  });
  assert.equal((await request("PATCH", "/api/tasks/" + child.id, { effort: "大" })).status, 400);
  await request("DELETE", "/api/tasks/" + parent.id);
  const reopenedDb = openDatabase(directory, true);
  const [reopened] = createTaskStore(reopenedDb).list();
  reopenedDb.close();
  assert.deepEqual(reopened, { ...child, dueDate: details.dueDate, priority: "高", effort: "小" });
  await run("setTaskDetails", { id: child.id, changes: { dueDate: null } });
  assert.deepEqual(await run("listTasks", { dueDate: details.dueDate }), []);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const conversations: ChatMessage[][] = [];
  const { request } = await startTestApp(t, async (messages) => {
    conversations.push(messages);
    return "收到";
  });
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("持久对话拒绝旧版本的更改，清空对话保留任务", async (t) => {
  const { request, store } = await startTestApp(t);
  store.create("保留任务");
  const empty = { revision: 0, messages: [], pending: false };
  assert.deepEqual((await request("GET", "/api/chat")).body, empty);
  assert.equal((await request("GET", "/api/chat?after=0")).status, 204);
  assert.equal(
    (await request("POST", "/api/chat", { action: "clear", revision: 0 })).body.revision,
    1,
  );
  assert.equal(
    (await request("POST", "/api/chat", { action: "send", revision: 0, text: "旧请求" })).status,
    409,
  );
  assert.deepEqual((await request("GET", "/api/chat")).body, { ...empty, revision: 1 });
  assert.equal(store.list()[0].title, "保留任务");
});

test(
  "持久对话完成后可重新读取，重复提交旧请求只创建一个任务",
  { skip: process.env.RUN_LIVE_AGENT_TEST !== "1" },
  async (t) => {
    const { request, store } = await startTestApp(t);
    const command = { action: "send", revision: 0, text: "添加任务「整理收据」。" };
    const [a, b] = await Promise.all([
      request("POST", "/api/chat", command),
      request("POST", "/api/chat", command),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const saved = (await request("GET", "/api/chat")).body;
    assert.deepEqual(saved, a.status === 200 ? a.body : b.body);
    assert.deepEqual(
      saved.messages.map((m: ChatMessage) => m.role),
      ["user", "assistant"],
    );
    assert.equal(saved.messages[0].content, command.text);
    assert.match(saved.messages[1].content, /整理收据/);
    assert.deepEqual(
      store.list().map((t) => t.title),
      ["整理收据"],
    );
    const cleared = await request("POST", "/api/chat", {
      action: "clear",
      revision: saved.revision,
    });
    assert.deepEqual(cleared.body.messages, []);
    assert.equal(store.list().length, 1);
  },
);

test(
  "Pi 通过实时 DeepSeek 对话删除指定任务并保留其他记录",
  {
    skip: process.env.RUN_LIVE_AGENT_TEST !== "1",
  },
  async (t) => {
    assert.ok(process.env.DEEPSEEK_API_KEY, "实时测试需要 DEEPSEEK_API_KEY");
    const { request, store } = await startTestApp(t);
    const keep = store.create("买牛奶");
    store.create("取快递");
    const response = await request("POST", "/api/chat", {
      messages: [{ role: "user", content: "取快递这条删掉吧" }],
    });
    assert.equal(response.status, 200);
    assert.match(response.body.reply, /取快递/u);
    assert.deepEqual(store.list(), [keep]);
  },
);

test(
  "小明按当前筛选预览批量改期，点击确认才写入",
  { skip: process.env.RUN_LIVE_AGENT_TEST !== "1" },
  async (t) => {
    const { request, store } = await startTestApp(t);
    const a = store.create("买水果");
    const b = store.create("买牛奶");
    const c = store.create("写报告");
    const response = await request("POST", "/api/chat", {
      messages: [{ role: "user", content: "把这些任务都改到 2027-03-06。" }],
      context: { view: "购物", visibleIds: [a.id, b.id], selectedId: null },
    });
    assert.equal(response.status, 200);
    assert.deepEqual([...response.body.preview.titles].sort(), [a.title, b.title].sort());
    assert.ok(store.list().every((task) => !task.dueDate));
    assert.equal(
      (await request("POST", "/api/planner/reschedule/" + response.body.preview.token)).status,
      204,
    );
    assert.deepEqual(
      store.list().map((task) => [task.id, task.dueDate]),
      [
        [a.id, "2027-03-06"],
        [b.id, "2027-03-06"],
        [c.id, undefined],
      ],
    );
  },
);

test(
  "小明建立每周五的任务，从原任务 API 完成后只生成一个带提醒的下周任务",
  { skip: process.env.RUN_LIVE_AGENT_TEST !== "1" },
  async (t) => {
    const { request, store } = await startTestApp(t);
    await request("POST", "/api/planner/timezone", { timeZone: "Asia/Singapore" });
    const response = await request("POST", "/api/chat", {
      messages: [
        {
          role: "user",
          content:
            "请创建任务「交周报」，从 2030-01-04 周五开始，每周五到期，提前一天（周四）下午三点提醒我。",
        },
      ],
    });
    assert.equal(response.status, 200);
    const [first] = store.list();
    assert.equal(first.repeat, "weekly");
    assert.equal(first.reminder, "2030-01-03T15:00");
    for (let i = 0; i < 2; i++)
      assert.equal((await request("PATCH", "/api/tasks/" + first.id, { done: true })).status, 200);
    const occurrences = store.list();
    assert.equal(occurrences.length, 2);
    assert.equal(occurrences[1].dueDate, "2030-01-11");
    assert.equal(occurrences[1].reminder, "2030-01-10T15:00");
  },
);
