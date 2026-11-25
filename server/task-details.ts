import { z } from "zod";
import { efforts, priorities } from "../shared/task.ts";
import type { TaskStore } from "./task-store.ts";

export const detailsSchema = z
  .strictObject({
    dueDate: z.iso.date().nullable().optional(),
    priority: z.enum(priorities).nullable().optional(),
    effort: z.enum(efforts).nullable().optional(),
    parentId: z.string().min(1).nullable().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, "请指定需要修改的字段。");

export type TaskDetails = z.infer<typeof detailsSchema>;

export function setDetails(store: TaskStore, id: string, changes: TaskDetails) {
  if (changes.parentId) {
    const tasks = new Map(store.list().map((task) => [task.id, task]));
    const seen = new Set([id]);
    let ancestor: unknown = changes.parentId;
    while (typeof ancestor === "string") {
      if (seen.has(ancestor)) return { error: "任务之间不能循环嵌套。" };
      seen.add(ancestor);
      const parent = tasks.get(ancestor);
      if (!parent) return { error: "找不到父任务。" };
      ancestor = parent.parentId;
    }
  }
  return store.update(id, changes) ?? { error: "找不到这条任务。" };
}
