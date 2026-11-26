import { createHash, randomUUID } from "node:crypto";
import type { ChatQuestion, ChoiceOperation, QuestionAnswer, SortChange } from "../shared/chat.ts";
import { inbox, localMinute, offsetDate, type Planner } from "../shared/planner.ts";
import { PlannerError } from "./task-details.ts";
import type { TaskStore } from "./task-store.ts";
import { requestTask } from "./task-request.ts";

export function candidate(planner: Planner, id: string) {
  const task = planner.tasks.find((t) => t.id === id);
  if (!task) return;
  const list = planner.lists.find((l) => l.id === (task.listId ?? inbox))?.name ?? "收件箱";
  const version = createHash("sha256")
    .update(JSON.stringify([task, list]))
    .digest("hex");
  return {
    id,
    title: task.title,
    list,
    dueDate: task.dueDate ?? null,
    dueTime: task.dueTime ?? null,
    version,
  };
}
export function deadlineQuestion(planner: Planner, id: string): ChatQuestion | undefined {
  const task = candidate(planner, id);
  if (!task || task.dueTime) return;
  const timeZone = planner.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localMinute(new Date(), timeZone).slice(0, 10);
  return {
    kind: "deadline",
    id: randomUUID(),
    task,
    today,
    tomorrow: offsetDate(today, 1),
    timeZone,
  };
}
export function choiceQuestion(
  planner: Planner,
  ids: string[],
  operation: ChoiceOperation,
): ChatQuestion | undefined {
  const tasks = [...new Set(ids)]
    .map((id) => candidate(planner, id))
    .filter((t) => t !== undefined);
  if (tasks.length) return { kind: "choice", id: randomUUID(), tasks, operation };
}
export function answerLabel(q: ChatQuestion, a: QuestionAnswer) {
  if (a.kind === "dismiss")
    return q.kind === "choice" ? "取消" : q.task.dueDate ? "仅设日期" : "暂不设置";
  if (q.kind === "deadline" && a.kind === "deadline")
    return [a.date, a.time].filter(Boolean).join(" ");
  if (q.kind === "choice" && a.kind === "choose") {
    const t = q.tasks.find((t) => t.id === a.taskId);
    if (t) return `${t.title} · ${t.list} · ${t.dueDate ?? "无截止日期"}`;
  }
  throw new PlannerError("请选择当前问题中的选项。");
}

export interface QuestionResult {
  reply: string;
  question?: ChatQuestion;
  sortChange?: SortChange;
}
export function refreshQuestion(store: TaskStore, q: ChatQuestion): QuestionResult {
  const p = store.snapshot();
  const question =
    q.kind === "deadline"
      ? deadlineQuestion(p, q.task.id)
      : choiceQuestion(
          p,
          q.tasks.map((t) => t.id),
          q.operation,
        );
  return {
    reply: question
      ? "任务信息已变化，请查看最新选项再决定。"
      : "这项任务安排已变化，本次操作已取消。",
    question,
  };
}
export async function resolveQuestion(
  store: TaskStore,
  port: number,
  q: ChatQuestion,
  a: QuestionAnswer,
): Promise<QuestionResult> {
  const label = answerLabel(q, a);
  if (a.kind === "dismiss")
    return { reply: q.kind === "choice" ? "已取消操作。" : `已保留「${q.task.title}」的安排。` };
  const candidates = q.kind === "deadline" ? [q.task] : q.tasks;
  const planner = store.snapshot();
  if (candidates.some((t) => candidate(planner, t.id)?.version !== t.version))
    return refreshQuestion(store, q);
  const task =
    q.kind === "deadline" ? q.task : q.tasks.find((t) => a.kind === "choose" && t.id === a.taskId)!;
  let result;
  let reply;
  if (q.kind === "choice" && q.operation.kind === "delete") {
    result = await requestTask(port, "DELETE", task.id, undefined, "tasks", task.version);
    reply = `已删除「${task.title}」（${task.list}）。`;
  } else {
    const current = planner.tasks.find((t) => t.id === task.id)!;
    const changes =
      q.kind === "choice" && q.operation.kind === "update"
        ? q.operation.changes
        : a.kind === "deadline"
          ? {
              dueDate: a.date,
              dueTime: a.time ?? null,
              ...(current.reminder && { reminder: current.reminder }),
            }
          : undefined;
    if (!changes) throw new PlannerError("答案与问题不匹配。");
    const scope =
      q.kind === "choice" && q.operation.kind === "update" ? q.operation.scope : undefined;
    result = await requestTask(
      port,
      "PATCH",
      task.id,
      { changes, scope },
      "planner/tasks",
      task.version,
    );
    reply =
      q.kind === "deadline"
        ? `「${task.title}」的截止时间已设为 ${label}。`
        : changes.done === true
          ? `已完成「${task.title}」（${task.list}）。`
          : `已更新「${task.title}」（${task.list}）。`;
  }
  if (result.stale || (result.error && !candidate(store.snapshot(), task.id)))
    return refreshQuestion(store, q);
  if (result.error) throw new PlannerError(result.error);
  return { reply };
}
