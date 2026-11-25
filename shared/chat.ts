import { z } from "zod";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export type ChatMessage = z.infer<typeof messageSchema>;
const revision = z.number().int().nonnegative();
const previewSchema = z.object({
  token: z.string(),
  date: z.string(),
  titles: z.array(z.string()),
});
export type BulkPreview = z.infer<typeof previewSchema>;
export const conversationSchema = z.object({
  revision,
  messages: z.array(messageSchema),
  pending: z.boolean(),
  preview: previewSchema.optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;
const viewContext = z.object({
  view: z.string(),
  visibleIds: z.array(z.string()),
  selectedId: z.string().nullable(),
});
export type ViewContext = z.infer<typeof viewContext>;

export const conversationCommand = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("send"),
    revision,
    text: z.string().trim().min(1).max(16000),
    context: viewContext.optional(),
  }),
  z.object({ action: z.literal("clear"), revision }),
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
