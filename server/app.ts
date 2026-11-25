import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { chatRequestSchema, type ChatMessage } from "../shared/chat.ts";
import type { TaskStore } from "./task-store.ts";
import { taskRouter } from "./tasks.ts";
import { reply as agentReply } from "./agent.ts";
import { taskTools } from "./task-tools.ts";
import { bulkPreviews, plannerRouter } from "./planner.ts";
import { PlannerError } from "./task-details.ts";
import { ZodError } from "zod";
import type { BulkPreview } from "../shared/chat.ts";

interface AppDependencies {
  reply?(messages: ChatMessage[]): Promise<string>;
  tasks: TaskStore;
}

export function createApp({ reply, tasks }: AppDependencies) {
  const app = express();
  const bulk = bulkPreviews(tasks);
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/chat", async (req, res) => {
    const input = chatRequestSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
    }
    let preview: BulkPreview | undefined;
    const { tasks: current, lists, timeZone } = tasks.snapshot();
    const answer = reply
      ? await reply(input.data.messages)
      : await agentReply(
          input.data.messages,
          taskTools(req.socket.localPort!, tasks, (ids, date) => {
            preview = bulk.preview(ids, date);
            return preview;
          }),
          current,
          { view: input.data.context, lists, timeZone },
        );
    res.json({ reply: answer, preview });
  });

  app.use("/api/tasks", taskRouter(tasks));
  app.use("/api/planner", plannerRouter(tasks, bulk));
  app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));
  app.use(handleApiError);

  app.use(express.static(resolve("public")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  return app;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof PlannerError || error instanceof ZodError)
    return res.status(400).json({
      error: error instanceof PlannerError ? error.message : "请检查输入的任务或清单字段。",
    });
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "请求需要使用有效的 JSON。" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "对话太长，请刷新后开始新的对话。" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
