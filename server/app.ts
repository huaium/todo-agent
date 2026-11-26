import { resolve } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import {
  chatRequestSchema,
  conversationCommand,
  type ChatMessage,
  type ViewContext,
  type ChatQuestion,
  type SortChange,
} from "../shared/chat.ts";
import { answerLabel, candidate, resolveQuestion, type QuestionResult } from "./chat-questions.ts";
import { ChatConflict, interruptedReply, type openConversation } from "./conversation.ts";
import type { TaskStore } from "./task-store.ts";
import { taskRouter } from "./tasks.ts";
import { reply as agentReply } from "./agent.ts";
import { taskTools } from "./task-tools.ts";
import { bulkPreviews, plannerRouter } from "./planner.ts";
import { PlannerError } from "./task-details.ts";
import { ApprovalTurn } from "./chat-approval.ts";
import { chatWriteReview } from "./task-request.ts";
import { ZodError } from "zod";
import type { BulkPreview } from "../shared/chat.ts";

interface AppDependencies {
  reply?(messages: ChatMessage[]): Promise<string>;
  tasks: TaskStore;
  chat: ReturnType<typeof openConversation>;
}

export function createApp({ reply, tasks, chat }: AppDependencies) {
  const app = express();
  const bulk = bulkPreviews(tasks);
  let reviewTurn: ApprovalTurn | undefined;
  app.use(express.json({ limit: "1mb" }));

  async function respond(
    messages: ChatMessage[],
    port: number,
    view?: ViewContext,
    interactive = false,
    previous?: ChatQuestion,
    signal?: AbortSignal,
    turn?: number,
  ) {
    let sortChange: SortChange | undefined;
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
            turn !== undefined && view?.sorting
              ? {
                  context: view,
                  apply(choice) {
                    sortChange = {
                      ...choice,
                      turn,
                      tab: view.sorting!.tab,
                      viewKey: view.sorting!.viewKey,
                    };
                  },
                }
              : undefined,
          ),
          current,
          { view, lists, timeZone, question: previous },
          signal,
        );
    return {
      reply: preview ? answer : (interactionResult?.reply ?? answer),
      preview,
      question: preview ? undefined : interactionResult?.question,
      sortChange,
    };
  }

  app.get("/api/chat", (req, res) => {
    res.set("Cache-Control", "no-store");
    return req.query.after === String(chat.state().revision)
      ? res.sendStatus(204)
      : res.json(chat.read());
  });
  app.post("/api/chat", async (req, res) => {
    const port = req.socket.localPort!;
    if (req.body?.action === undefined) {
      const input = chatRequestSchema.safeParse(req.body);
      if (!input.success)
        return res.status(400).json({ error: "请提供对话记录，并以用户消息结尾。" });
      const result = await chatWriteReview.run(
        async () => {
          if (chat.state().approvalMode === "cautious")
            throw new PlannerError("审慎模式下请通过聊天面板提交并审批更改。");
        },
        () => respond(input.data.messages, port, input.data.context),
      );
      return res.json(result);
    }
    const command = conversationCommand.parse(req.body);
    const current = chat.state();
    if (current.revision !== command.revision)
      return res.status(409).json({ error: "对话已更新，请查看最新消息。" });
    if (command.action === "review") {
      if (!reviewTurn || !current.approval || command.token !== current.approval.token)
        return res.status(409).json({ error: "审批已更新，请查看最新消息。" });
      await reviewTurn.decide(command.allow);
      return res.json(chat.read());
    }
    if (current.pending) return res.status(409).json({ error: "请先完成当前对话或审批。" });
    if (command.action === "setApprovalMode") {
      chat.setApprovalMode(command.revision, command.mode);
      return res.json(chat.read());
    }
    if (command.action === "clear") {
      if (current.preview) bulk.discard(current.preview.token);
      chat.clear(command.revision);
      return res.json(chat.read());
    }
    if (command.action === "send" || command.action === "answer") {
      const previous = chat.lastQuestion();
      if (command.action === "answer" && (!previous || previous.id !== command.questionId))
        return res.status(409).json({ error: "此问题已更新，请查看最新消息。" });
      const content =
        command.action === "send" ? command.text : answerLabel(previous!, command.answer);
      chat.begin(command.revision, content);
      const pendingRevision = command.revision + 1;
      if (current.preview) bulk.discard(current.preview.token);
      const work = (signal?: AbortSignal) =>
        command.action === "answer"
          ? resolveQuestion(tasks, port, previous!, command.answer)
          : respond(chat.context(), port, command.context, true, previous, signal, pendingRevision);
      if (current.approvalMode === "cautious") {
        reviewTurn = new ApprovalTurn(chat, tasks, pendingRevision);
        await reviewTurn.start(work);
        return res.json(chat.read());
      }
      let result: QuestionResult & { preview?: BulkPreview };
      try {
        result = await work();
      } catch (error) {
        chat.appendReply(pendingRevision, true, interruptedReply);
        throw error;
      }
      chat.appendReply(
        pendingRevision,
        true,
        result.reply,
        result.preview,
        result.question,
        result.sortChange,
      );
      return res.json(chat.read());
    }
    const preview = current.preview;
    if (!preview || preview.token !== command.token)
      return res.status(409).json({ error: "改期预览已变更。" });
    if (command.action === "cancel") {
      bulk.discard(preview.token);
      chat.appendReply(command.revision, false, "已取消改期。");
      return res.json(chat.read());
    }
    try {
      bulk.confirm(preview.token);
    } catch (error) {
      if (error instanceof PlannerError) chat.appendReply(command.revision, false, error.message);
      throw error;
    }
    chat.appendReply(
      command.revision,
      false,
      `已将 ${preview.titles.length} 条任务改到 ${preview.date}。`,
    );
    return res.json(chat.read());
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
  app.use("/assets/speech", express.static(resolve("dist/speech")));
  app.get("/assets/chat.js", (_req, res) => res.sendFile(resolve("dist/chat.js")));
  app.get("/assets/initial-theme.js", (_req, res) =>
    res.sendFile(resolve("dist/initial-theme.js")),
  );
  app.get("/assets/theme.css", (_req, res) => res.sendFile(resolve("dist/theme.css")));
  return app;
}

const handleApiError: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ChatConflict) return res.status(409).json({ error: error.message });
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
