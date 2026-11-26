import { z } from "zod";
import { plannerChanges } from "./task-details.ts";
import { taskMethods } from "./view-sort.ts";

export const chatSort = z.strictObject({
  method: z.enum([...taskMethods, "deleted"]),
  reverse: z.boolean(),
});
const sortTarget = chatSort.extend({
  viewKey: z.union([
    z.enum(["today", "upcoming", "starred", "all", "done", "bin"]),
    z.string().regex(/^list:.+$/),
  ]),
  tab: z.string().min(1).max(100),
});
const sortContext = sortTarget.extend({
  groupView: z.enum(["today", "upcoming", "other"]),
});
const sortChange = sortTarget.extend({
  turn: z.number().int().nonnegative(),
});
export type SortChange = z.infer<typeof sortChange>;

const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  list: z.string(),
  parentPath: z.array(z.string()).optional(),
  dueDate: z.iso.date().nullable(),
  dueTime: z.iso.time({ precision: -1 }).nullable(),
  version: z.string(),
});
export const choiceOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("delete") }),
  z.object({
    kind: z.literal("update"),
    changes: plannerChanges,
    scope: z.enum(["one", "future"]).optional(),
  }),
]);
const questionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deadline"),
    id: z.string(),
    task: candidateSchema,
    today: z.iso.date(),
    tomorrow: z.iso.date(),
    timeZone: z.string(),
  }),
  z.object({
    kind: z.literal("choice"),
    id: z.string(),
    tasks: z.array(candidateSchema).min(1),
    operation: choiceOperation,
  }),
]);
export const questionAnswer = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("deadline"),
    date: z.iso.date(),
    time: z.iso.time({ precision: -1 }).optional(),
  }),
  z.object({ kind: z.literal("choose"), taskId: z.string().min(1) }),
  z.object({ kind: z.literal("dismiss") }),
]);
export type ChatQuestion = z.infer<typeof questionSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswer>;
export type ChoiceOperation = z.infer<typeof choiceOperation>;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
  question: questionSchema.optional(),
  sortChange: sortChange.optional(),
});

export type ChatMessage = z.infer<typeof messageSchema>;
const revision = z.number().int().nonnegative();
const previewSchema = z.object({
  token: z.string(),
  date: z.string(),
  titles: z.array(z.string()),
});
export type BulkPreview = z.infer<typeof previewSchema>;
export const approvalMode = z.enum(["allow", "cautious"]);
export type ApprovalMode = z.infer<typeof approvalMode>;
const approvalSchema = z.object({
  token: z.string(),
  title: z.string(),
  details: z.array(z.string()),
});
export type ChatApproval = z.infer<typeof approvalSchema>;
export const conversationSchema = z.object({
  revision,
  messages: z.array(messageSchema),
  pending: z.boolean(),
  preview: previewSchema.optional(),
  approvalMode: approvalMode.optional(),
  approval: approvalSchema.optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
const viewContext = z.object({
  view: z.string(),
  visibleIds: z.array(z.string()),
  selectedId: z.string().nullable(),
  sorting: sortContext.optional(),
});
export type ViewContext = z.infer<typeof viewContext>;

export const conversationCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("setApprovalMode"), revision, mode: approvalMode }),
  z.object({ action: z.literal("review"), revision, token: z.string(), allow: z.boolean() }),
  z.object({
    action: z.literal("send"),
    revision,
    text: z.string().trim().min(1).max(16000),
    context: viewContext.optional(),
  }),
  z.object({ action: z.literal("clear"), revision }),
  z.object({
    action: z.literal("answer"),
    revision,
    questionId: z.string(),
    answer: questionAnswer,
  }),
  z.object({ action: z.enum(["confirm", "cancel"]), revision, token: z.string() }),
]);
export type ConversationCommand = z.infer<typeof conversationCommand>;

export const chatRequestSchema = z.object({
  context: viewContext.optional(),
  messages: z
    .array(messageSchema)
    .min(1)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
