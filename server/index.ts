import { createApp } from "./app.ts";
import { createTaskStore } from "./task-store.ts";
import { openDatabase } from "./database.ts";
import { openConversation } from "./conversation.ts";
import { acquireServerLock } from "./server-lock.ts";

const lock = acquireServerLock("data");
const db = openDatabase("data");
const chat = openConversation(db);
const tasks = createTaskStore(db);
tasks.purgeExpired();
const app = createApp({ tasks, chat });
const cleanup = setInterval(tasks.purgeExpired, 60_000).unref();
const server = app
  .listen(Number(process.env.PORT || 3000), "127.0.0.1", (error?: Error) => {
    if (error) throw error;
    chat.recover();
    const address = server.address();
    if (address && typeof address === "object")
      console.log(`小明智能体已启动：http://127.0.0.1:${address.port}`);
  })
  .once("close", () => {
    clearInterval(cleanup);
    db.close();
    lock.close();
  });
