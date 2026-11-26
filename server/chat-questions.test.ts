import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { ChatQuestion, Conversation, QuestionAnswer } from "../shared/chat.ts";
import { createApp } from "./app.ts";
import { choiceQuestion, deadlineQuestion } from "./chat-questions.ts";
import { openConversation } from "./conversation.ts";
import { createTaskStore, type TaskStore } from "./task-store.ts";
import { importLegacyDatabase, openDatabase } from "./database.ts";
import { choiceDescription } from "../shared/task-choice.ts";

test("duplicate subtask choices show parent paths and refresh after a parent rename", async (t) => {
  const { q, store, answer } = await restore(t, (store) => {
    const ids = ["论文", "合同"].map(
      (title) => store.create("校对", { parentId: store.create(title).id }).id,
    );
    return choiceQuestion(store.snapshot(), ids, { kind: "delete" })!;
  });
  assert.ok(q.kind === "choice");
  assert.match(choiceDescription(q.tasks[0], q.tasks), /论文/);
  assert.match(choiceDescription(q.tasks[1], q.tasks), /合同/);
  store.update(store.list()[0].id, { title: "文章" });
  const next: Conversation = await (
    await answer(1, q.id, { kind: "choose", taskId: q.tasks[0].id })
  ).json();
  const revised = next.messages.at(-1)?.question;
  assert.ok(revised?.kind === "choice");
  assert.match(choiceDescription(revised.tasks[0], revised.tasks), /文章/);
  await answer(next.revision, revised.id, { kind: "choose", taskId: q.tasks[0].id });
  assert.deepEqual(
    store
      .list()
      .filter((task) => task.title === "校对")
      .map((t) => t.id),
    [q.tasks[1].id],
  );
});

async function restore(t: TestContext, setup: (store: TaskStore) => ChatQuestion) {
  const dir = await mkdtemp(join(tmpdir(), "planner-questions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(dir);
  t.after(() => db.close());
  const store = createTaskStore(db);
  const q = setup(store);
  const chat = openConversation(db);
  chat.appendReply(0, false, { reply: "请选择", question: q });
  const server = createApp({ tasks: store, chat }).listen(0, "127.0.0.1");
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
  const command = (body: object) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { read, answer, q, store, command };
}
test("cautious mode gates chat writes across reloads, checks revisions, and supports cancellation", async (t) => {
  function setup(store: TaskStore) {
    const task = store.create("采购");
    return deadlineQuestion(store.snapshot(), task.id)!;
  }
  const { read, answer, q, store, command } = await restore(t, setup);
  const chooseDate = (revision: number) =>
    answer(revision, q.id, { kind: "deadline", date: "2031-01-01" });
  const mode = await command({ action: "setApprovalMode", revision: 1, mode: "cautious" });
  assert.equal((await mode.json()).approvalMode, "cautious");
  const paused: Conversation = await (await chooseDate(2)).json();
  assert.ok(paused.approval);
  assert.match(paused.approval.title, /采购/);
  assert.ok(paused.approval.details.some((line) => line.includes("2031-01-01")));
  assert.equal(store.list()[0].dueDate, undefined);
  assert.deepEqual((await read()).approval, paused.approval);
  const review = {
    action: "review",
    revision: paused.revision,
    token: paused.approval.token,
    allow: true,
  };
  assert.equal((await command({ ...review, token: "other" })).status, 409);
  const replies = await Promise.all([command(review), command(review)]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409]);
  assert.equal(store.list()[0].dueDate, "2031-01-01");
  assert.equal((await read()).approval, undefined);
  const second = await restore(t, setup);
  await second.command({ action: "setApprovalMode", revision: 1, mode: "cautious" });
  const next: Conversation = await (
    await second.answer(2, second.q.id, { kind: "deadline", date: "2032-01-01" })
  ).json();
  const canceled: Conversation = await (
    await second.command({
      action: "review",
      revision: next.revision,
      token: next.approval!.token,
      allow: false,
    })
  ).json();
  assert.equal(canceled.pending, false);
  assert.equal(second.store.list()[0].dueDate, undefined);
  assert.equal(canceled.approvalMode, "cautious");
  const reset = await second.command({
    action: "setApprovalMode",
    revision: canceled.revision,
    mode: "allow",
  });
  assert.equal((await reset.json()).approvalMode, "allow");
});
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

test("imported questions retain legacy task hashes and stale candidates stay stale", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "chat-question-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const task = {
    id: "a",
    title: "交表",
    done: false,
    notes: "",
    custom: { level: 2 },
    dueTime: null,
  };
  const planner = {
    version: 1 as const,
    tasks: [task],
    lists: [{ id: "inbox", name: "收件箱" }],
    timeZone: "Asia/Singapore",
    series: {},
  };
  const question = deadlineQuestion(planner, task.id)!;
  const legacy = {
    revision: 17,
    pending: false,
    messages: [{ role: "assistant", content: "什么时候完成？", question }],
  };
  await writeFile(join(dir, "tasks.json"), JSON.stringify(planner));
  await writeFile(join(dir, "tasks.json.chat.json"), JSON.stringify(legacy));
  importLegacyDatabase(dir);
  const db = openDatabase(dir);
  t.after(() => db.close());
  const store = createTaskStore(db);
  const chat = openConversation(db);
  chat.recover();
  assert.deepEqual(chat.read(), legacy);
  const server = createApp({ tasks: store, chat }).listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api";
  assert.ok(question.kind === "deadline");
  const patch = () =>
    fetch(url + "/tasks/a", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"' + question.task.version + '"',
      },
      body: JSON.stringify({ title: "交表" }),
    });
  assert.equal((await patch()).status, 200);
  const answer = await fetch(url + "/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "answer",
      revision: 17,
      questionId: question.id,
      answer: { kind: "deadline", date: "2030-04-05" },
    }),
  });
  assert.equal(answer.status, 200);
  assert.equal(store.list()[0].dueDate, "2030-04-05");
  assert.equal((await patch()).status, 412);
});
