import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { createTaskSchema, updateTaskSchema } from "./tasks.ts";
import { detailsSchema, setDetails } from "./task-details.ts";
import type { TaskStore } from "./task-store.ts";
import type { Task } from "../shared/task.ts";
import type { BulkPreview } from "../shared/chat.ts";

export interface TaskTool extends AgentTool<object, unknown> {
  writes: boolean;
}

export function taskTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.output<S>) => Promise<unknown>,
  writes = false,
): TaskTool {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema);
  return {
    writes,
    name,
    label: description,
    description,
    parameters,
    async execute(_callId, args) {
      const result = schema.safeParse(args);
      const details = result.success
        ? await run(result.data)
        : { error: result.error.issues.map(({ path, message }) => ({ path, message })) };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
        isError: details !== null && typeof details === "object" && "error" in details,
      };
    },
  };
}

export function taskTools(
  port: number,
  store: TaskStore,
  preview?: (ids: string[], date: string) => BulkPreview,
): TaskTool[] {
  const collection = `http://127.0.0.1:${port}/api/tasks`;
  async function request(method: string, id?: string, body?: unknown) {
    const url = id === undefined ? collection : `${collection}/${encodeURIComponent(id)}`;
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 204) return { deleted: id };
    if (!response.ok && response.status !== 400 && response.status !== 404) {
      throw new Error(`任务接口返回 HTTP ${response.status}`);
    }
    return response.json();
  }
  const id = z.string().min(1).describe("从任务清单读取的任务 ID");
  return [
    ...(preview
      ? [
          taskTool(
            "previewReschedule",
            "批量改期必须先预览，用户点击确认后才保存。",
            z.strictObject({ ids: z.array(id).min(1), date: z.iso.date() }),
            async ({ ids, date }) => {
              const result = preview(ids, date);
              return {
                reply: `请确认将以下 ${result.titles.length} 条任务改到 ${date}：\n${result.titles.join("\n")}`,
              };
            },
          ),
        ]
      : []),
    taskTool(
      "listTasks",
      "读取清单。查找 ID 时省略 display，只需向用户展示清单时传 display=true。",
      z.strictObject({
        dueDate: z.iso.date().optional(),
        done: z.boolean().optional(),
        parentId: id.optional(),
        display: z.boolean().optional(),
      }),
      async ({ display, ...filters }) => {
        const tasks: Task[] = await request("GET");
        const matches = tasks.filter((task) =>
          Object.entries(filters).every(([field, value]) => task[field] === value),
        );
        if (!display) return matches;
        return {
          reply: matches.length
            ? matches
                .map((task) => `· ${task.title}（${task.done ? "已完成" : "待办"}）`)
                .join("\n")
            : "没有符合条件的任务。",
        };
      },
    ),
    taskTool(
      "createTask",
      "创建一条未完成的任务",
      createTaskSchema,
      ({ title }) => request("POST", undefined, { title }),
      true,
    ),
    taskTool(
      "updateTask",
      "修改指定任务的标题或完成状态",
      z.strictObject({ id, changes: updateTaskSchema }),
      ({ id, changes }) => request("PATCH", id, changes),
      true,
    ),
    taskTool(
      "deleteTask",
      "删除用户指定的单条任务",
      z.strictObject({ id }),
      ({ id }) => request("DELETE", id),
      true,
    ),
    taskTool(
      "setTaskDetails",
      "设置单条任务的清单、标签、星标、备注、优先级、工作量、父任务、截止日期、时间、提醒或重复频率。reminder 是规划时区的 YYYY-MM-DDTHH:mm。每周重复用 weekly。批量改期使用 previewReschedule。",
      z.strictObject({ id, changes: detailsSchema }),
      async ({ id, changes }) => setDetails(store, id, changes),
      true,
    ),
    taskTool(
      "showTasksDue",
      "直接向用户展示指定日期的到期清单。用于单独的到期查询。默认只看未完成，done 为 null 时包括全部状态。",
      z.strictObject({ date: z.iso.date(), done: z.boolean().nullable().optional() }),
      async ({ date, done = false }) => {
        const tasks: Task[] = await request("GET");
        const rows = tasks.filter(
          (task) => task.dueDate === date && (done === null || task.done === done),
        );
        const scope = done === null ? "" : done ? "已完成" : "未完成";
        const heading = `${date} 到期的${scope}任务`;
        const reply = rows.length
          ? [
              heading + "：",
              ...rows.map((task) => `· ${task.title}（${task.done ? "已完成" : "待办"}）`),
            ].join("\n")
          : `${heading}：无。`;
        return { reply };
      },
    ),
    taskTool(
      "replyWithoutChanges",
      "用于问候、澄清、解释、分析查询结果或报告失败。此工具不修改任务，不能用于确认写入成功。",
      z.strictObject({ message: z.string().trim().min(1) }),
      async ({ message }) => ({ reply: message }),
    ),
  ];
}
