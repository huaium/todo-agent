import { z } from "zod";
import { efforts, priorities } from "../shared/task.ts";
import { frequencies } from "../shared/planner.ts";

export const detailsSchema = z
  .strictObject({
    dueDate: z.iso.date().nullable().optional(),
    dueTime: z.iso.time({ precision: -1 }).nullable().optional(),
    reminder: z.iso
      .datetime({ local: true, precision: -1 })
      .refine((v) => v.length === 16)
      .nullable()
      .optional(),
    repeat: z.enum(frequencies).nullable().optional(),
    priority: z.enum(priorities).nullable().optional(),
    effort: z.enum(efforts).nullable().optional(),
    parentId: z.string().min(1).nullable().optional(),
    listId: z.string().min(1).optional(),
    notes: z.string().max(10000).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    starred: z.boolean().optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, "请指定需要修改的字段。");
export type TaskDetails = z.infer<typeof detailsSchema>;
export class PlannerError extends Error {}
