import type { DatabaseSync } from "node:sqlite";
import type { BulkPreview, ChatMessage, ChatQuestion } from "../shared/chat.ts";
import {
  chatState,
  insertMessage,
  readConversation,
  readMessages,
  transaction,
} from "./database.ts";

export const interruptedReply = "这次回复中断了。请先核对清单，再决定是否重新发送。";

export class ChatConflict extends Error {
  constructor() {
    super("对话已更新，请查看最新消息。");
  }
}
export function openConversation(db: DatabaseSync) {
  const advance = db.prepare(
    "UPDATE conversation SET revision=revision+1,pending=?,preview=? WHERE id=1 AND revision=? AND pending=?",
  );
  function write(
    revision: number,
    wasPending: boolean,
    pending: boolean,
    message?: ChatMessage,
    preview?: BulkPreview,
  ) {
    transaction(db, () => {
      if (
        !advance.run(Number(pending), JSON.stringify(preview) ?? null, revision, Number(wasPending))
          .changes
      )
        throw new ChatConflict();
      if (message) insertMessage(db, message);
      else db.exec("DELETE FROM messages");
    });
  }
  function appendReply(
    revision: number,
    wasPending: boolean,
    content: string,
    preview?: BulkPreview,
    question?: ChatQuestion,
  ) {
    write(
      revision,
      wasPending,
      false,
      { role: "assistant", content, ...(question && { question }) },
      preview,
    );
  }
  return {
    state: () => chatState(db),
    read: () => transaction(db, () => readConversation(db), "DEFERRED"),
    lastQuestion: () => readMessages(db, 1)[0]?.question,
    context: () => recentContext(readMessages(db, 100)),
    begin: (revision: number, content: string) =>
      write(revision, false, true, { role: "user", content }),
    clear: (revision: number) => write(revision, false, false),
    appendReply,
    recover() {
      const state = chatState(db);
      // A committed tool action must never be replayed on restart.
      if (state.pending) appendReply(state.revision, true, interruptedReply);
      else if (state.preview)
        appendReply(state.revision, false, "服务已重启，上次改期预览已失效。请重新预览。");
    },
  };
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
