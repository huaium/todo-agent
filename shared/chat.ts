import { z } from "zod";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
});

export type ChatMessage = z.infer<typeof messageSchema>;
export interface BulkPreview {
  token: string;
  date: string;
  titles: string[];
}
const viewContext = z.object({
  view: z.string(),
  visibleIds: z.array(z.string()),
  selectedId: z.string().nullable(),
});
export type ViewContext = z.infer<typeof viewContext>;

export const chatRequestSchema = z.object({
  context: viewContext.optional(),
  messages: z
    .array(messageSchema)
    .min(1)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
