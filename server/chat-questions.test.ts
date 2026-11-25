import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { ChatQuestion, Conversation, QuestionAnswer } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { choiceQuestion, deadlineQuestion } from "./chat-questions.ts";
import { openConversation } from "./conversation.ts";
import { createJsonTaskStore, type TaskStore } from "./task-store.ts";

async function restore(t: TestContext, setup: (store: TaskStore) => ChatQuestion) {
  const dir = await mkdtemp(join(tmpdir(), "planner-questions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(dir, "tasks.json"));
  const q = setup(store);
  const chat = openConversation(store.filename + ".chat.json");
  chat.appendReply("请选择", undefined, q);
  const server = createApp({ tasks: store }).listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/chat";
  const read = async (): Promise<Conversation> => (await fetch(url)).json();
  const answer = (revision: number, questionId: string, answer: QuestionAnswer) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "answer", revision, questionId, answer }),
    });
  assert.deepEqual((await read()).messages.at(-1)?.question, q);
  return { read, answer, q, store };
}
test("重开对话后只能回答一次截止时间，保留独立提醒", async (t) => {
  const { read, answer, q, store } = await restore(t, (s) => {
    const task = s.create("采购", { reminder: "2030-01-02T13:00" });
    return deadlineQuestion(s.snapshot(), task.id)!;
  });
  const submission = () => answer(1, q.id, { kind: "deadline", date: "2030-01-08", time: "17:45" });
  const responses = await Promise.all([submission(), submission()]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const [task] = store.list();
  assert.equal(task.dueDate, "2030-01-08");
  assert.equal(task.dueTime, "17:45");
  assert.equal(task.reminder, "2030-01-02T13:00");
  const { messages } = await read();
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, "user");
  assert.match(messages[2].content, /2030-01-08 17:45/);
  assert.equal(messages[2].question, undefined);
});
test("删除或修改候选任务会重新询问，即使只剩一个也需确认", async (t) => {
  const { q, answer, store, read } = await restore(t, (s) => {
    const a = s.create("周报"),
      b = s.create("周报");
    return choiceQuestion(s.snapshot(), [a.id, b.id], { kind: "delete" })!;
  });
  assert.ok(q.kind === "choice");
  const [a, b] = q.tasks;
  store.remove(a.id);
  assert.equal((await answer(1, q.id, { kind: "choose", taskId: b.id })).status, 200);
  const refreshed = await read(),
    next = refreshed.messages.at(-1)?.question;
  assert.ok(next?.kind === "choice");
  assert.notEqual(next.id, q.id);
  assert.deepEqual(
    next.tasks.map((t) => t.id),
    [b.id],
  );
  assert.equal(store.list().length, 1);
  assert.equal(
    (await answer(refreshed.revision, next.id, { kind: "choose", taskId: a.id })).status,
    400,
  );
  assert.equal(
    (await answer(refreshed.revision, next.id, { kind: "choose", taskId: b.id })).status,
    200,
  );
  assert.equal(store.list().length, 0);
});
test("跳过具体时间保留已保存的日期", async (t) => {
  const { q, answer, store, read } = await restore(t, (s) => {
    const task = s.create("交表", { dueDate: "2030-03-04" });
    return deadlineQuestion(s.snapshot(), task.id)!;
  });
  const original = store.list();
  assert.equal((await answer(1, q.id, { kind: "dismiss" })).status, 200);
  assert.deepEqual(store.list(), original);
  assert.equal((await read()).messages[1].content, "仅设日期");
});
