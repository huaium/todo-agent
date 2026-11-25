import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { interruptedReply, openConversation, recentContext } from "./conversation.ts";
import type { ChatMessage } from "../shared/chat.ts";
import { openDatabase } from "./database.ts";

test("重启后保留对话并结束中断的请求，只记录一次中断", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "planner-conversation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(dir);
  const chat = openConversation(db);
  const messages: ChatMessage[] = [{ role: "user", content: "买茶叶" }];
  chat.begin(0, messages[0].content);
  db.close();
  const reopened = openDatabase(dir);
  t.after(() => reopened.close());
  const recovered = openConversation(reopened);
  recovered.recover();
  assert.deepEqual(recovered.read(), {
    revision: 2,
    pending: false,
    messages: [...messages, { role: "assistant", content: interruptedReply }],
  });
  recovered.recover();
  assert.equal(recovered.state().revision, 2);
  recovered.appendReply(2, false, "待确认", {
    token: "preview",
    date: "2030-04-09",
    titles: ["买茶叶"],
  });
  recovered.recover();
  const afterRestart = recovered.read();
  assert.equal(afterRestart.preview, undefined);
  assert.match(afterRestart.messages.at(-1)!.content, /预览已失效/);
});

test("长对话保留完整记录，仅将最近的完整轮次传给模型", () => {
  const messages: ChatMessage[] = Array.from({ length: 201 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: String(i),
  }));
  const context = recentContext(messages);
  assert.equal(context[0].role, "user");
  assert.ok(context.length <= 100);
  assert.equal(context.at(-1), messages.at(-1));
  assert.equal(messages.length, 201);
  const large: ChatMessage[] = [
    { role: "user", content: "a".repeat(48000) },
    { role: "assistant", content: "ok" },
    { role: "user", content: "下一条" },
  ];
  assert.deepEqual(recentContext(large), large.slice(-1));
});
