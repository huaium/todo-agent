import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ApprovalMode,
  ChatApproval,
  BulkPreview,
  ChatMessage,
  ChatQuestion,
} from "../shared/chat.ts";
import type { QuestionResult } from "./chat-questions.ts";
import {
  chatState,
  insertMessage,
  readConversation,
  readChatPage,
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
  let history = randomUUID();
  const advance = db.prepare(
    "UPDATE conversation SET revision=revision+1,pending=?,preview=CASE WHEN ? THEN preview ELSE ? END,active_question_seq=CASE WHEN ? THEN NULL ELSE active_question_seq END,approval=NULL WHERE id=1 AND revision=? AND pending=?",
  );
  function write(
    revision: number,
    wasPending: boolean,
    pending: boolean,
    message?: ChatMessage,
    preview?: BulkPreview | null,
  ) {
    transaction(db, () => {
      if (
        !advance.run(
          Number(pending),
          Number(preview === undefined),
          preview ? JSON.stringify(preview) : null,
          Number(pending || wasPending || !message),
          revision,
          Number(wasPending),
        ).changes
      )
        throw new ChatConflict();
      if (message) {
        const inserted = insertMessage(db, message);
        if (message.question)
          db.prepare("UPDATE conversation SET active_question_seq=? WHERE id=1").run(
            inserted.lastInsertRowid,
          );
      } else db.exec("DELETE FROM messages");
    });
  }
  function appendReply(
    revision: number,
    wasPending: boolean,
    result: string | (QuestionResult & { preview?: BulkPreview | null }),
  ) {
    const {
      reply: content,
      preview,
      ...details
    } = typeof result === "string" ? { reply: result } : result;
    write(
      revision,
      wasPending,
      false,
      {
        role: "assistant",
        content,
        ...details,
      },
      preview,
    );
  }
  return {
    state: () => chatState(db),
    read: () => transaction(db, () => readConversation(db), "DEFERRED"),
    get history() {
      return history;
    },
    page(cursor: { history?: string; since?: number; before?: number }) {
      return transaction(
        db,
        () => readChatPage(db, history, cursor.history === history ? cursor : {}),
        "DEFERRED",
      );
    },
    lastQuestion(): ChatQuestion | undefined {
      const row = db
        .prepare(
          "SELECT question FROM messages WHERE seq=(SELECT active_question_seq FROM conversation WHERE id=1)",
        )
        .get();
      return row && JSON.parse(String(row.question));
    },
    context: () => recentContext(readMessages(db, 100)),
    begin: (revision: number, content: string) =>
      write(revision, false, true, { role: "user", content }),
    clear(revision: number) {
      write(revision, false, false, undefined, null);
      history = randomUUID();
    },
    appendReply,
    expirePreview(revision: number) {
      if (
        !db
          .prepare(
            "UPDATE conversation SET preview=NULL,revision=revision+1 WHERE id=1 AND revision=? AND pending=0 AND preview IS NOT NULL",
          )
          .run(revision).changes
      )
        throw new ChatConflict();
    },
    setApprovalMode(revision: number, mode: ApprovalMode) {
      if (
        !db
          .prepare(
            "UPDATE conversation SET approval_mode=?,revision=revision+1 WHERE id=1 AND revision=? AND pending=0",
          )
          .run(mode, revision).changes
      )
        throw new ChatConflict();
    },
    setApproval(revision: number, approval?: ChatApproval) {
      if (
        !db
          .prepare(
            "UPDATE conversation SET approval=?,revision=revision+1 WHERE id=1 AND revision=? AND pending=1",
          )
          .run(JSON.stringify(approval) ?? null, revision).changes
      )
        throw new ChatConflict();
    },
    recover() {
      const state = chatState(db);
      // A committed tool action must never be replayed on restart.
      if (state.pending)
        appendReply(state.revision, true, {
          reply: state.approval ? "服务已重启，待审批的更改已取消。" : interruptedReply,
          preview: null,
        });
      else if (state.preview)
        appendReply(state.revision, false, {
          reply: "服务已重启，上次改期预览已失效。请重新预览。",
          preview: null,
        });
    },
  };
}

// Retain the complete transcript on disk. Send a bounded suffix to the model.
export function recentContext(messages: ChatMessage[]) {
  const messageLength = (message: ChatMessage) =>
    message.content.length +
    (message.createdTasks?.reduce((sum, task) => sum + task.title.length + 1, 0) ?? 0);
  let start = messages.length - 1;
  let length = messageLength(messages[start]);
  while (
    start > 0 &&
    messages.length - start < 100 &&
    length + messageLength(messages[start - 1]) <= 48000
  ) {
    length += messageLength(messages[--start]);
  }
  while (start < messages.length - 1 && messages[start].role !== "user") start++;
  return messages.slice(start);
}
