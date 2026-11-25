import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { taskTools } from "./task-tools.ts";

async function startTestApp(t: TestContext, reply?: (messages: ChatMessage[]) => Promise<string>) {
  const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "tasks.json");
  const app = createApp({ tasks: createJsonTaskStore(filename), reply });

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

  return { request, filename, port };
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

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("模型工具通过任务 HTTP 接口读写，参数错误不改变清单", async (t) => {
  const { request, port, filename } = await startTestApp(t);
  const tools = taskTools(port, createJsonTaskStore(filename));
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
  assert.equal(createJsonTaskStore(filename).list()[0].done, true);
  await execute("deleteTask", { id: task.id });
  assert.deepEqual(await execute("listTasks", {}), []);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("任务详情持久化，筛选到期子任务并保留已删除父任务的子项", async (t) => {
  const { request, port, filename } = await startTestApp(t);
  const store = createJsonTaskStore(filename);
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
  const [reopened] = createJsonTaskStore(filename).list();
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

test(
  "Pi 通过实时 DeepSeek 对话删除指定任务并保留其他记录",
  {
    skip: process.env.RUN_LIVE_AGENT_TEST !== "1",
  },
  async (t) => {
    assert.ok(process.env.DEEPSEEK_API_KEY, "实时测试需要 DEEPSEEK_API_KEY");
    const { request, filename } = await startTestApp(t);
    const store = createJsonTaskStore(filename);
    const keep = store.create("买牛奶");
    store.create("取快递");
    const response = await request("POST", "/api/chat", {
      messages: [{ role: "user", content: "取快递这条删掉吧" }],
    });
    assert.equal(response.status, 200);
    assert.match(response.body.reply, /取快递/u);
    assert.deepEqual(createJsonTaskStore(filename).list(), [keep]);
  },
);

test(
  "小明按当前筛选预览批量改期，点击确认才写入",
  { skip: process.env.RUN_LIVE_AGENT_TEST !== "1" },
  async (t) => {
    const { request, filename } = await startTestApp(t);
    const store = createJsonTaskStore(filename);
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
