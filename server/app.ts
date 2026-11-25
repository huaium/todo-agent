import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import {
  chatRequestSchema,
  conversationCommand,
  type ChatMessage,
  type ViewContext,
  type ChatQuestion,
} from "../shared/chat.ts";
import { answerLabel, candidate, resolveQuestion, type QuestionResult } from "./chat-questions.ts";
import { interruptedReply, openConversation, recentContext } from "./conversation.ts";
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
  const chat = openConversation(tasks.filename + ".chat.json");
  app.use(express.json({ limit: "1mb" }));

  async function respond(
    messages: ChatMessage[],
    port: number,
    view?: ViewContext,
    interactive = false,
    previous?: ChatQuestion,
  ) {
    let preview: BulkPreview | undefined;
    let interactionResult: QuestionResult | undefined;
    const { tasks: current, lists, timeZone } = tasks.snapshot();
    const answer = reply
      ? await reply(messages)
      : await agentReply(
          messages,
          taskTools(
            port,
            tasks,
            (ids, date) => {
              preview = bulk.preview(ids, date);
              return preview;
            },
            interactive
              ? {
                  previous,
                  respond(result) {
                    interactionResult = result;
                  },
                }
              : undefined,
          ),
          current,
          { view, lists, timeZone, question: previous },
        );
    return {
      reply: preview ? answer : (interactionResult?.reply ?? answer),
      preview,
      question: preview ? undefined : interactionResult?.question,
    };
  }

  app.get("/api/chat", (req, res) => {
    const state = chat.read();
    res.set("Cache-Control", "no-store");
    return req.query.after === String(state.revision) ? res.sendStatus(204) : res.json(state);
  });
  app.post("/api/chat", async (req, res) => {
    const port = req.socket.localPort!;
    if (req.body?.action === undefined) {
      const input = chatRequestSchema.safeParse(req.body);
      if (!input.success)
        return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
      return res.json(await respond(input.data.messages, port, input.data.context));
    }
    const command = conversationCommand.parse(req.body);
    const current = chat.read();
    if (current.revision !== command.revision || current.pending)
      return res.status(409).json({ error: "对话已更新，请查看最新消息。" });
    if (command.action === "clear") {
      if (current.preview) bulk.discard(current.preview.token);
      return res.json(chat.save({ messages: [], pending: false }));
    }
    if (command.action === "send" || command.action === "answer") {
      const previous = current.messages.at(-1)?.question;
      if (command.action === "answer" && (!previous || previous.id !== command.questionId))
        return res.status(409).json({ error: "此问题已更新，请查看最新消息。" });
      const content =
        command.action === "send" ? command.text : answerLabel(previous!, command.answer);
      const messages: ChatMessage[] = [...current.messages, { role: "user", content }];
      chat.save({ messages, pending: true });
      if (current.preview) bulk.discard(current.preview.token);
      let result: QuestionResult & { preview?: BulkPreview };
      try {
        result =
          command.action === "answer"
            ? await resolveQuestion(tasks, port, previous!, command.answer)
            : await respond(recentContext(messages), port, command.context, true, previous);
      } catch (error) {
        chat.appendReply(interruptedReply);
        throw error;
      }
      return res.json(chat.appendReply(result.reply, result.preview, result.question));
    }
    const preview = current.preview;
    if (!preview || preview.token !== command.token)
      return res.status(409).json({ error: "改期预览已变更。" });
    if (command.action === "cancel") {
      bulk.discard(preview.token);
      return res.json(chat.appendReply("已取消改期。"));
    }
    try {
      bulk.confirm(preview.token);
    } catch (error) {
      if (error instanceof PlannerError) chat.appendReply(error.message);
      throw error;
    }
    return res.json(chat.appendReply(`已将 ${preview.titles.length} 条任务改到 ${preview.date}。`));
  });

  app.all(["/api/tasks/:id", "/api/planner/tasks/:id"], (req, res, next) => {
    const match = req.get("If-Match");
    if (
      match &&
      (typeof req.params.id !== "string" ||
        match !== `"${candidate(tasks.snapshot(), req.params.id)?.version}"`)
    )
      return res.status(412).json({ stale: true, error: "任务信息已变化。" });
    next();
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
    return res.status(413).json({ error: "请求内容过长，请缩短后再发送。" });
  }
  console.error(error);
  res.status(500).json({ error: "服务暂时无法处理请求，请稍后重试。" });
};
