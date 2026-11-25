import { createApp } from "./app.ts";
import { createTaskStore } from "./task-store.ts";
import { openDatabase } from "./database.ts";
import { openConversation } from "./conversation.ts";

const db = openDatabase("data");
const chat = openConversation(db);
const app = createApp({ tasks: createTaskStore(db), chat });
const port = Number(process.env.PORT || 3000);
app
  .listen(port, "127.0.0.1", (error?: Error) => {
    if (error) throw error;
    chat.recover();
    console.log(`小明智能体已启动：http://127.0.0.1:${port}`);
  })
  .once("close", () => db.close());
