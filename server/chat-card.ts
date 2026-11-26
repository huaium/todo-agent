import type { CardTask, TaskCard } from "../shared/chat.ts";
import { inbox, repeatLabels, type PlannerTask } from "../shared/planner.ts";
import type { TaskStore } from "./task-store.ts";

export function cardTask(store: TaskStore, task: PlannerTask, fields: object = {}): CardTask {
  const context = store.taskContext(task.id);
  const details: string[] = [];
  if ("priority" in fields) details.push("优先级 · " + (task.priority ?? "未设置"));
  if ("tags" in fields)
    details.push(task.tags?.length ? task.tags.map((tag) => "#" + tag).join(" ") : "标签已清除");
  if ("reminder" in fields)
    details.push("提醒 · " + (task.reminder?.replace("T", " ") ?? "未设置"));
  if ("repeat" in fields)
    details.push("重复 · " + (task.repeat ? repeatLabels[task.repeat] : "不重复"));
  if ("effort" in fields) details.push("工作量 · " + (task.effort ?? "未设置"));
  if ("notes" in fields) details.push(task.notes ? "备注已保存" : "备注已清除");
  if ("starred" in fields) details.push(task.starred ? "已加星标" : "已取消星标");
  if ("parentId" in fields)
    details.push(
      task.parentId
        ? "父任务 · " + context.tasks.find((t) => t.id === task.parentId)?.title
        : "独立任务",
    );
  return {
    id: task.id,
    title: task.title,
    done: task.done,
    list: context.lists.find((l) => l.id === (task.listId ?? inbox))?.name ?? "收件箱",
    dueDate: task.dueDate ?? null,
    dueTime: task.dueTime ?? null,
    ...(details.length && { details }),
  };
}

export function changedCard(
  store: TaskStore,
  before: CardTask,
  after: PlannerTask | undefined,
  fields: object,
): TaskCard {
  if (!after) return { kind: "deleted", tasks: [before] };
  const row = cardTask(store, after, fields);
  if (before.done && !after.done) row.details = ["已恢复为待办", ...(row.details ?? [])];
  if (row.dueDate !== before.dueDate || row.dueTime !== before.dueTime)
    row.previousDeadline = [before.dueDate, before.dueTime].filter(Boolean).join(" ") || "未设日期";
  return { kind: after.done && !before.done ? "completed" : "updated", tasks: [row] };
}
