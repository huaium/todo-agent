import { randomUUID } from "node:crypto";
import type { BulkPreview, ChatApproval } from "../shared/chat.ts";
import { inbox, repeatLabels, type Planner } from "../shared/planner.ts";
import type { QuestionResult } from "./chat-questions.ts";
import { interruptedReply, type openConversation } from "./conversation.ts";
import { PlannerError } from "./task-details.ts";
import { chatWriteReview, type TaskWrite } from "./task-request.ts";
import type { TaskStore } from "./task-store.ts";
import type { ChatCapture } from "./chat-capture.ts";

const labels: Record<string, string> = {
  title: "标题",
  done: "完成",
  dueDate: "截止日期",
  dueTime: "截止时间",
  reminder: "提醒",
  repeat: "重复",
  starred: "星标",
  listId: "清单",
  parentId: "父任务",
  priority: "优先级",
  effort: "工作量",
  notes: "备注",
  tags: "标签",
};

function describe(write: TaskWrite, planner: Planner): Omit<ChatApproval, "token"> {
  const body = (write.body ?? {}) as Record<string, unknown>;
  if (write.resource === "view/sort")
    return { title: `更改「${body.view}」排序`, details: [String(body.label)] };
  const task = planner.tasks.find((t) => t.id === write.id);
  const listName = (id: unknown) =>
    planner.lists.find((l) => l.id === (id ?? inbox))?.name ?? String(id);
  if (write.resource === "planner/tasks/order") {
    const source = planner.tasks.find((t) => t.id === body.id);
    const anchor = planner.tasks.find((t) => t.id === body.anchorId);
    const parent = planner.tasks.find((t) => t.id === anchor?.parentId);
    const details = ["在任务视图中使用手动排序"];
    if ((source?.parentId ?? null) !== (anchor?.parentId ?? null))
      details.unshift(parent ? `移为「${parent.title}」的子任务` : "移为独立任务");
    return {
      title: `将「${source?.title ?? body.id}」移到「${anchor?.title ?? body.anchorId}」${body.side === "before" ? "上方" : "下方"}`,
      details,
    };
  }
  if (write.resource === "planner/lists") {
    const name = write.id ? listName(write.id) : String(body.name);
    if (write.method === "POST") return { title: `创建清单「${name}」`, details: [] };
    if (write.method === "PATCH")
      return { title: `重命名清单「${name}」`, details: ["新名称：" + body.name] };
    return { title: `删除清单「${name}」`, details: ["清单内的任务将移入收件箱。"] };
  }
  const name = task?.title ?? String(body.title ?? write.id);
  if (write.resource === "planner/reminders")
    return { title: `将「${name}」的提醒延后 10 分钟`, details: [String(body.at)] };
  if (write.method === "DELETE")
    return { title: `将「${name}」移入回收站`, details: [listName(task?.listId)] };
  const creating = write.method === "POST";
  const changes = (body.changes ?? body) as Record<string, unknown>;
  const details = Object.entries(changes)
    .filter(([key]) => !(creating && key === "title"))
    .map(([key, value]) => {
      let text = value == null ? "清除" : String(value);
      if (typeof value === "boolean") text = value ? "是" : "否";
      if (Array.isArray(value)) text = value.join("、") || "清除";
      if (key === "listId") text = listName(value);
      if (key === "parentId" && value)
        text = planner.tasks.find((t) => t.id === value)?.title ?? text;
      if (key === "repeat" && value)
        text = repeatLabels[value as keyof typeof repeatLabels] ?? text;
      return `${labels[key] ?? key}：${text}`;
    });
  if (body.scope === "future") details.push("应用于本次及后续重复任务");
  return { title: `${creating ? "创建" : "修改"}任务「${name}」`, details };
}

type Result = QuestionResult & { preview?: BulkPreview | null };

function approvalContext(write: TaskWrite, planner: Planner) {
  if (write.resource === "planner/tasks/order") {
    const { id, anchorId } = write.body as { id: string; anchorId: string };
    return JSON.stringify([
      describe(write, planner),
      planner.tasks.filter((t) => t.id === id || t.id === anchorId),
    ]);
  }
  // A change elsewhere in the planner should not invalidate an unrelated approval.
  const affected = planner.tasks
    .filter((task) =>
      write.resource === "planner/lists"
        ? write.method === "DELETE" && (task.listId ?? inbox) === write.id
        : write.id && (task.id === write.id || task.parentId === write.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify([describe(write, planner), affected]);
}

// The running turn pauses immediately before each planner write. Each POST returns
// at the next approval or the end of the turn, so refreshes never replay tool calls.
export class ApprovalTurn {
  private boundary = Promise.withResolvers<void>();
  private decision?: ReturnType<typeof Promise.withResolvers<void>>;
  private readonly abort = new AbortController();
  private revision: number;
  private readonly chat: ReturnType<typeof openConversation>;
  private readonly tasks: TaskStore;
  private readonly capture: ChatCapture;
  constructor(
    chat: ReturnType<typeof openConversation>,
    tasks: TaskStore,
    revision: number,
    capture: ChatCapture,
  ) {
    this.chat = chat;
    this.tasks = tasks;
    this.revision = revision;
    this.capture = capture;
  }
  private interrupt(reply: string) {
    const result = this.capture.finish(this.tasks, { reply }, { interrupted: true });
    this.chat.appendReply(this.revision, true, result);
  }
  private async review(write: TaskWrite) {
    this.abort.signal.throwIfAborted();
    const snapshot = this.tasks.snapshot();
    const approval = { token: randomUUID(), ...describe(write, snapshot) };
    this.chat.setApproval(this.revision, approval);
    this.revision++;
    this.decision = Promise.withResolvers<void>();
    this.boundary.resolve();
    await this.decision.promise;
    this.abort.signal.throwIfAborted();
    if (approvalContext(write, this.tasks.snapshot()) !== approvalContext(write, snapshot))
      throw new PlannerError("清单在审批期间已变化，请重新核对后再试。");
  }
  start(work: (signal: AbortSignal) => Promise<Result>) {
    const response = this.boundary.promise;
    void chatWriteReview.run(
      (write) => this.review(write),
      async () => {
        try {
          const result = await work(this.abort.signal);
          if (!this.abort.signal.aborted) this.chat.appendReply(this.revision, true, result);
          this.boundary.resolve();
        } catch (error) {
          if (this.abort.signal.aborted) return;
          this.interrupt(error instanceof PlannerError ? error.message : interruptedReply);
          this.boundary.reject(error);
        }
      },
    );
    return response;
  }
  decide(allow: boolean) {
    const decision = this.decision;
    if (!decision) throw new PlannerError("审批已结束。");
    this.decision = undefined;
    if (!allow) {
      this.interrupt("已取消待审批的更改。");
      this.abort.abort();
      decision.resolve();
      return Promise.resolve();
    }
    this.chat.setApproval(this.revision);
    this.revision++;
    this.boundary = Promise.withResolvers<void>();
    decision.resolve();
    return this.boundary.promise;
  }
}
