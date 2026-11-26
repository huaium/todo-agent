import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { createTaskSchema, updateTaskSchema } from "./tasks.ts";
import { efforts, priorities } from "../shared/task.ts";
import { detailsSchema } from "./task-details.ts";
import { localMinute, pendingReminder, type PlannerTask } from "../shared/planner.ts";
import { binMethods, taskMethods, sortLabels, directionLabels } from "../shared/view-sort.ts";
import type { TaskStore } from "./task-store.ts";
import {
  choiceOperation,
  chatSort,
  type ViewContext,
  type SortChange,
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
import { chatWriteReview, requestTask } from "./task-request.ts";

export interface TaskTool extends AgentTool<object, unknown> {
  writes: boolean;
}
const pageSize = 20;
const pageOffset = z.number().int().nonnegative().optional();
function summary(task: PlannerTask) {
  const { id, title, done } = task;
  const result: Record<string, unknown> = { id, title: title.slice(0, 200), done };
  for (const key of [
    "listId",
    "parentId",
    "dueDate",
    "dueTime",
    "priority",
    "effort",
    "starred",
    "repeat",
    "reminder",
  ])
    if (task[key] != null) result[key] = task[key];
  return result;
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
  ui?: { context: ViewContext; apply(choice: z.infer<typeof chatSort>): void },
  view?: ViewContext,
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
  const sorting = ui?.context.sorting;
  return [
    ...(ui && sorting
      ? [
          taskTool(
            "setViewSort",
            "更改当前界面的排序方式。manual 手动、due 截止、priority 优先级、effort 工作量、title 标题、deleted 删除时间。reverse=false 表示最早到期、高优先、小工作量、标题正序或最近删除。",
            chatSort,
            async (choice) => {
              const methods: readonly SortChange["method"][] =
                sorting.viewKey === "bin" ? binMethods : taskMethods;
              if (
                !methods.includes(choice.method) ||
                (choice.method === "manual" && choice.reverse)
              )
                return { error: "此视图不支持该排序。" };
              const label = [
                sortLabels[choice.method],
                directionLabels[choice.method][Number(choice.reverse)],
              ]
                .filter(Boolean)
                .join(" · ");
              await chatWriteReview.getStore()?.({
                resource: "view/sort",
                method: "SET",
                body: { label, view: ui.context.view },
              });
              ui.apply(choice);
              return { reply: `已将当前视图设为${label}。` };
            },
            true,
          ),
        ]
      : []),
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
            z.strictObject({
              ids: z.array(id).min(1).optional(),
              visible: z.boolean().optional(),
              date: z.iso.date(),
            }),
            async ({ ids, visible, date }) => {
              if (visible && (ids || !view)) return { error: "请选择当前视图或指定任务。" };
              const pendingVisible = visible
                ? new Set(
                    store
                      .search(
                        { visibleIds: view!.visibleIds, done: false },
                        0,
                        view!.visibleIds.length,
                      )
                      .map((task) => task.id),
                  )
                : undefined;
              const targets = pendingVisible
                ? view!.visibleIds.filter((id) => pendingVisible.has(id))
                : ids;
              if (!targets?.length) return { error: "没有待改期的任务。" };
              const result = preview(targets, date);
              return {
                reply: `请确认将 ${result.titles.length} 条任务改到 ${date}：\n${result.titles.slice(0, pageSize).join("\n")}${result.titles.length > pageSize ? "\n完整清单见改期预览。" : ""}`,
              };
            },
          ),
        ]
      : []),
    taskTool(
      "listTasks",
      "按关键词（标题、备注或标签）、清单、父任务、日期、星标、优先级、工作量或状态搜索。每页最多20条。visible=true 仅查当前视图。查找 ID 时省略 display，用户要求展示清单时传 display=true。更多结果用 nextOffset 翻页。",
      z.strictObject({
        dueDate: z.iso.date().optional(),
        done: z.boolean().optional(),
        starred: z.boolean().optional(),
        priority: z.enum(priorities).optional(),
        effort: z.enum(efforts).optional(),
        parentId: id.optional(),
        query: z.string().max(200).optional(),
        listId: id.optional(),
        id: id.optional(),
        visible: z.boolean().optional(),
        offset: pageOffset,
        display: z.boolean().optional(),
      }),
      async ({ display, visible, offset = 0, ...filters }) => {
        if (visible && !view) return { error: "当前请求未指定视图。" };
        const page = store.search(
          { ...filters, visibleIds: visible ? view!.visibleIds : undefined },
          offset,
          pageSize + 1,
        );
        const matches = page.slice(0, pageSize).map(summary);
        const more = page.length > pageSize;
        if (!display) return more ? { tasks: matches, nextOffset: offset + pageSize } : matches;
        return {
          reply: matches.length
            ? matches
                .map((task) => `· ${task.title}（${task.done ? "已完成" : "待办"}）`)
                .join("\n") +
              (more ? `\n还有更多任务，可从第 ${offset + pageSize + 1} 条继续查看。` : "")
            : "没有符合条件的任务。",
        };
      },
    ),
    taskTool(
      "findLists",
      "按名称关键词查找清单 ID，支持翻页。",
      z.strictObject({ query: z.string().max(80).optional(), offset: pageOffset }),
      async ({ query = "", offset = 0 }) => {
        const lists = store.findLists(query, offset, pageSize + 1);
        return {
          lists: lists.slice(0, pageSize),
          ...(lists.length > pageSize && { nextOffset: offset + pageSize }),
        };
      },
    ),
    taskTool(
      "readTaskDetails",
      "需要查看指定任务的备注、标签或详细信息时使用。长备注用 noteOffset 翻页。",
      z.strictObject({ id, noteOffset: pageOffset }),
      async ({ id, noteOffset = 0 }) => {
        const [task] = store.search({ id }, 0, 1);
        if (!task) return { error: "任务不存在。" };
        const notes = task.notes ?? "";
        return {
          ...summary(task),
          tags: task.tags,
          notes: notes.slice(noteOffset, noteOffset + 1600),
          ...(notes.length > noteOffset + 1600 && { nextNoteOffset: noteOffset + 1600 }),
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
          const question = deadlineQuestion(store.taskContext(task.id), task.id);
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
      async (move) => {
        if (sorting?.viewKey === "bin")
          return { error: "回收站按删除时间或标题排序，请打开任务清单后移动。" };
        const snapshot = store.snapshot();
        const source = snapshot.tasks.find((t) => t.id === move.id),
          anchor = snapshot.tasks.find((t) => t.id === move.anchorId);
        if (!source || !anchor) return { error: "移动项或参照项已不存在。" };
        if (
          sorting &&
          !anchor.parentId &&
          sorting.groupView !== "other" &&
          source.dueDate &&
          anchor.dueDate
        ) {
          const today = localMinute(
            new Date(),
            snapshot.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          ).slice(0, 10);
          const different =
            sorting.groupView === "upcoming"
              ? source.dueDate !== anchor.dueDate
              : source.dueDate < today !== anchor.dueDate < today;
          if (
            different &&
            ui?.context.visibleIds.includes(source.id) &&
            ui.context.visibleIds.includes(anchor.id)
          )
            return {
              error: "这两条任务在不同日期分组中。请在全部视图调整顺序，或明确要修改的截止日期。",
            };
        }
        const expected = {
          source: candidate(snapshot, source.id)!.version,
          anchor: candidate(snapshot, anchor.id)!.version,
        };
        const result = await requestTask(
          port,
          "POST",
          undefined,
          { ...move, expected },
          "planner/tasks/order",
        );
        if (result.error) return result;
        ui?.apply({ method: "manual", reverse: false });
        return {
          moved: result.id,
          anchor: anchor.title,
          side: move.side,
          parentChanged: (source.parentId ?? null) !== (result.parentId ?? null),
          parentId: result.parentId ?? null,
          ...(ui && {
            sort: "manual",
            bothInFilter:
              ui.context.visibleIds.includes(source.id) &&
              ui.context.visibleIds.includes(anchor.id),
          }),
        };
      },
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
        const [task] = store.search({ id }, 0, 1);
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
      z.strictObject({
        date: z.iso.date(),
        done: z.boolean().nullable().optional(),
        offset: pageOffset,
      }),
      async ({ date, done = false, offset = 0 }) => {
        const page = store.search({ dueDate: date, done: done ?? undefined }, offset, pageSize + 1);
        const rows = page.slice(0, pageSize);
        const scope = done === null ? "" : done ? "已完成" : "未完成";
        const heading = `${date} 到期的${scope}任务`;
        const reply = rows.length
          ? [
              heading + "：",
              ...rows.map((task) => `· ${task.title}（${task.done ? "已完成" : "待办"}）`),
            ].join("\n") +
            (page.length > pageSize
              ? `\n还有更多任务，可从第 ${offset + pageSize + 1} 条继续查看。`
              : "")
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
