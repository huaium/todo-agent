import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { createTaskSchema, updateTaskSchema } from "./tasks.ts";
import { detailsSchema } from "./task-details.ts";
import { pendingReminder } from "../shared/planner.ts";
import type { TaskStore } from "./task-store.ts";
import type { Task } from "../shared/task.ts";
import {
  choiceOperation,
  questionAnswer,
  type ChatQuestion,
  type BulkPreview,
} from "../shared/chat.ts";
import {
  choiceQuestion,
  candidate,
  refreshQuestion,
  deadlineQuestion,
  resolveQuestion,
  type QuestionResult,
} from "./chat-questions.ts";
import { requestTask } from "./task-request.ts";

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
  interaction?: { previous?: ChatQuestion; respond(result: QuestionResult): void },
): TaskTool[] {
  async function request(method: string, id?: string, body?: unknown, resource = "tasks") {
    const q = interaction?.previous;
    if (
      !q ||
      !id ||
      !["tasks", "planner/tasks"].includes(resource) ||
      !["PATCH", "DELETE"].includes(method)
    )
      return requestTask(port, method, id, body, resource);
    // A free-text turn can also invoke a regular task tool. Check the same snapshots as a click.
    const choices = q.kind === "deadline" ? [q.task] : q.tasks;
    const target = choices.find((t) => t.id === id);
    if (!target) return requestTask(port, method, id, body, resource);
    const snapshot = store.snapshot();
    if (choices.every((t) => candidate(snapshot, t.id)?.version === t.version)) {
      const result = await requestTask(port, method, id, body, resource, target.version);
      if (!result.stale) return result;
    }
    const updated = refreshQuestion(store, q);
    interaction!.respond(updated);
    return { error: updated.reply };
  }
  const id = z.string().min(1).describe("从任务清单读取的任务 ID");
  return [
    ...(interaction
      ? [
          taskTool(
            "askTaskChoice",
            "当单项修改或删除有多个可能目标时，提供候选任务 ID 和用户要求的操作，等待用户选择。",
            z.strictObject({ ids: z.array(id).min(2), operation: choiceOperation }),
            async ({ ids, operation }) => {
              const question = choiceQuestion(store.snapshot(), ids, operation);
              if (!question) return { error: "没有可选择的任务。" };
              const previous = interaction.previous;
              if (
                previous?.kind === "choice" &&
                question.kind === "choice" &&
                JSON.stringify(previous.operation) === JSON.stringify(operation) &&
                question.tasks.length === previous.tasks.length &&
                question.tasks.every((task) => previous.tasks.some((t) => t.id === task.id))
              ) {
                if (
                  question.tasks.some(
                    (task) => !previous.tasks.some((t) => t.version === task.version),
                  )
                ) {
                  const refreshed = refreshQuestion(store, previous);
                  interaction.respond(refreshed);
                  return refreshed;
                }
                interaction.respond({ reply: "你指的是哪一条？", question: previous });
                return {
                  error:
                    "这些候选项已向用户展示。请根据本轮给出的清单名、日期或标题区分候选项，调用 answerQuestion 传入匹配的任务 ID。如果仍无法区分，请说明缺少的信息。",
                };
              }
              const result = { reply: "你指的是哪一条？", question };
              interaction.respond(result);
              return result;
            },
          ),
        ]
      : []),
    ...(interaction?.previous
      ? [
          taskTool(
            "answerQuestion",
            "用用户本轮的自然语言回答上轮问题。若用户按清单或日期指明了哪一条，传入 {answer:{kind:'choose',taskId:匹配的候选ID}}，将执行已记录的操作。截止日期和可选时间用 deadline；跳过用 dismiss。",
            z.strictObject({ answer: questionAnswer }),
            async ({ answer }) => {
              const result = await resolveQuestion(store, port, interaction.previous!, answer);
              interaction.respond(result);
              return result;
            },
          ),
        ]
      : []),
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
      "创建未完成任务。若已知截止日期、重复、提醒、清单或父任务，用 details 一起保存。",
      createTaskSchema.extend({
        details: detailsSchema.optional(),
        skipDeadlineQuestion: z
          .boolean()
          .optional()
          .describe("仅当用户明确不要截止日期、仅设日期或不想被询问时传 true；未提及时间时省略。"),
      }),
      async ({ title, details, skipDeadlineQuestion }) => {
        const task = details
          ? await request("POST", undefined, { title, ...details }, "planner/tasks")
          : await request("POST", undefined, { title });
        if (interaction && task.id && !skipDeadlineQuestion && !task.dueTime) {
          const question = deadlineQuestion(store.snapshot(), task.id);
          if (question?.kind === "deadline")
            interaction.respond({
              question,
              reply: question.task.dueDate
                ? `已记下「${task.title}」，${question.task.dueDate} 到期。要设具体时间吗？`
                : `已把「${task.title}」加入${question.task.list}。什么时候需要完成？`,
            });
        }
        return task;
      },
      true,
    ),
    taskTool(
      "moveTaskRelative",
      "调整任务行顺序。将 id 移到 anchorId 的正上方(before)或正下方(after)，并使其与参照任务同级。移动到父任务上方会自动提升一级；无需先修改 parentId。",
      z.strictObject({ id, anchorId: id, side: z.enum(["before", "after"]) }),
      (move) => requestTask(port, "POST", undefined, move, "planner/tasks/order"),
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
      "把用户指定的单条任务移入回收站，可在 30 天内恢复。",
      z.strictObject({ id }),
      ({ id }) => request("DELETE", id),
      true,
    ),
    taskTool(
      "setTaskDetails",
      "设置单条任务的清单、标签、星标、备注、优先级、工作量、父任务、截止日期、时间、提醒或重复频率。reminder 是规划时区的 YYYY-MM-DDTHH:mm。每周重复用 weekly。批量改期使用 previewReschedule。",
      z.strictObject({ id, changes: detailsSchema, scope: z.enum(["one", "future"]).optional() }),
      ({ id, changes, scope }) => request("PATCH", id, { changes, scope }, "planner/tasks"),
      true,
    ),
    taskTool(
      "manageList",
      "创建、重命名或删除个人清单。删除清单后任务回到收件箱。",
      z.strictObject({
        action: z.enum(["create", "rename", "delete"]),
        id: id.optional(),
        name: z.string().trim().min(1).max(80).optional(),
      }),
      async ({ action, id, name }) => {
        if (action === "create" && name)
          return request("POST", undefined, { name }, "planner/lists");
        if (action === "rename" && id && name)
          return request("PATCH", id, { name }, "planner/lists");
        if (action === "delete" && id) return request("DELETE", id, undefined, "planner/lists");
        return { error: "请提供所需的清单 ID 或名称。" };
      },
      true,
    ),
    taskTool(
      "snoozeReminder",
      "将已到点的任务提醒延后十分钟。",
      z.strictObject({ id }),
      async ({ id }) => {
        const task = store.list().find((t) => t.id === id);
        const at = task && pendingReminder(task);
        if (!at) return { error: "找不到有效提醒。" };
        const result = await request("POST", id, { at, action: "snooze" }, "planner/reminders");
        return result.applied ? { snoozed: id } : { error: "提醒已更改或尚未到点。" };
      },
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
