import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  conversationSchema,
  type BulkPreview,
  type ChatMessage,
  type ChatQuestion,
  type Conversation,
} from "../shared/chat.ts";

export const interruptedReply = "这次回复中断了。请先核对清单，再决定是否重新发送。";

export function openConversation(filename: string) {
  let state: Conversation = existsSync(filename)
    ? conversationSchema.parse(JSON.parse(readFileSync(filename, "utf8")))
    : { revision: 0, pending: false, messages: [] };

  function save(next: Omit<Conversation, "revision">): Conversation {
    const updated = { ...next, revision: state.revision + 1 };
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename + ".tmp", JSON.stringify(updated), { mode: 0o600, flush: true });
    renameSync(filename + ".tmp", filename);
    state = updated;
    return state;
  }
  function appendReply(content: string, preview?: BulkPreview, question?: ChatQuestion) {
    return save({
      pending: false,
      messages: [...state.messages, { role: "assistant", content, ...(question && { question }) }],
      preview,
    });
  }

  // Tool calls may already have changed tasks. Never replay an interrupted turn.
  if (state.pending) {
    appendReply(interruptedReply);
  } else if (state.preview) {
    // Preview tokens belong to the running planner instance.
    appendReply("服务已重启，上次改期预览已失效。请重新预览。");
  }
  return { read: () => state, save, appendReply };
}

// Retain the complete transcript on disk. Send a bounded suffix to the model.
export function recentContext(messages: ChatMessage[]) {
  let start = messages.length - 1;
  let length = messages[start].content.length;
  while (
    start > 0 &&
    messages.length - start < 100 &&
    length + messages[start - 1].content.length <= 48000
  ) {
    length += messages[--start].content.length;
  }
  while (start < messages.length - 1 && messages[start].role !== "user") start++;
  return messages.slice(start);
}
