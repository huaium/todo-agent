import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function startTestApp(
  t: TestContext,
  reply?: (messages: ChatMessage[]) => Promise<string>,
  legacy?: unknown,
) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (legacy) await writeFile(join(directory, "tasks.json"), JSON.stringify(legacy));
  const db = openDatabase(directory);
  t.after(() => db.close());
  const store = createTaskStore(db);
  const app = createApp({ tasks: store, chat: openConversation(db), reply });

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

  return { request, store, port, directory };
}

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
  assert.equal((await request("DELETE", collection, body)).status, 404);
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

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  const { request, store } = await startTestApp(t, undefined, [first, second]);

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
