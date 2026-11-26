import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deadlineQuestion } from "./chat-questions.ts";
import { openConversation } from "./conversation.ts";
import { openDatabase } from "./database.ts";
import { createTaskStore } from "./task-store.ts";
import type { Conversation } from "../shared/chat.ts";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const env = { ...process.env, PORT: "0" };

async function start(t: TestContext, cwd: string) {
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  async function stop() {
    child.kill("SIGKILL");
    await closed;
  }
  t.after(stop);
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  for await (const line of lines) {
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) return { url: url + "/api/chat", stop };
  }
  throw new Error("Planner failed to start: " + errors);
}

test(
  "a second process cannot cancel a live approval; a restart after process death recovers it once",
  { timeout: 15_000 },
  async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "planner-ownership-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const db = openDatabase(join(cwd, "data"));
    const store = createTaskStore(db);
    const { id } = store.create("取件");
    const question = deadlineQuestion(store.snapshot(), id)!;
    const chat = openConversation(db);
    chat.setApprovalMode(0, "cautious");
    chat.appendReply(1, false, { reply: "什么时候完成？", question });
    db.close();

    const first = await start(t, cwd);
    const response = await fetch(first.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "answer",
        revision: 2,
        questionId: question.id,
        answer: { kind: "deadline", date: "2030-01-01" },
      }),
    });
    assert.equal(response.status, 200);
    const waiting: Conversation = await response.json();
    assert.ok(waiting.approval);
    await assert.rejects(
      promisify(execFile)(process.execPath, [entry], { cwd, env, timeout: 5000 }),
      /Another planner server/,
    );
    assert.deepEqual(await (await fetch(first.url)).json(), waiting);
    await first.stop();
    const second = await start(t, cwd);
    const recovered: Conversation = await (await fetch(second.url)).json();
    assert.equal(recovered.pending, false);
    assert.equal(recovered.approval, undefined);
    assert.equal(recovered.revision, waiting.revision + 1);
    assert.match(recovered.messages.at(-1)!.content, /服务已重启/);
    await second.stop();
    const third = await start(t, cwd);
    assert.deepEqual(await (await fetch(third.url)).json(), recovered);
  },
);
