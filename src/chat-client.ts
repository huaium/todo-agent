import type { ChatMessage, BulkPreview, ViewContext } from "../shared/chat.ts";
import { api } from "./planner-client.ts";
export function requestReply(messages: ChatMessage[], context: ViewContext) {
  return api<{ reply: string; preview?: BulkPreview }>("chat", "POST", { messages, context });
}
