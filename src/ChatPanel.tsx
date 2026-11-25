import { useEffect, useRef, useState } from "react";
import { Button, TextArea } from "@heroui/react";
import { ConfirmAction } from "./PlannerControls.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { useConversation } from "./chat-client.ts";
import type { ChatMessage, ViewContext } from "../shared/chat.ts";
export function ChatPanel({
  context,
  changed,
  close,
}: {
  context: ViewContext;
  changed(): Promise<void>;
  close(): void;
}) {
  const { state, active, error, reload, submit } = useConversation();
  const [draft, setDraft] = useState("");
  const [clearRevision, setClearRevision] = useState<number | null>(null);
  const busy = !state || !!active || state.pending;
  const sending = active?.action === "send" && active.revision === state?.revision;
  const history: ChatMessage[] = sending
    ? [...state!.messages, { role: "user", content: active.text }]
    : (state?.messages ?? []);
  const preview = !sending && state?.preview;
  const input = useRef<HTMLTextAreaElement>(null);
  const seenRevision = useRef<number>(undefined);
  useEffect(() => {
    if (!state || seenRevision.current === state.revision) return;
    const firstLoad = seenRevision.current === undefined;
    seenRevision.current = state.revision;
    if (!firstLoad && !state.pending) void changed();
  }, [state, changed]);
  async function send(text: string) {
    if (!text.trim() || !state || busy) return;
    setDraft("");
    const accepted = await submit({
      action: "send",
      text: text.trim(),
      context,
      revision: state.revision,
    });
    if (!accepted) setDraft(text);
    if (input.current?.offsetParent) input.current.focus();
  }
  async function applyPreview(action: "confirm" | "cancel") {
    if (!preview || !state || busy) return;
    await submit({ action, token: preview.token, revision: state.revision });
  }
  return (
    <aside className="chat-pane" aria-label="小明对话">
      <div className="pane-head">
        <img src="/logo.png" alt="" />
        <strong>小明</strong>
        {!!state?.messages.length && (
          <Button
            size="sm"
            variant="ghost"
            className="clear-chat"
            isDisabled={busy}
            onPress={() => setClearRevision(state.revision)}
          >
            清空对话
          </Button>
        )}
        <Button size="sm" variant="tertiary" className="mobile-only" onPress={close}>
          返回清单
        </Button>
      </div>
      <ConfirmAction
        open={clearRevision !== null}
        close={() => setClearRevision(null)}
        title="清空这段对话？"
        consequence="聊天记录和待回答的问题将被清除，清单中的任务会保留。"
        action="清空对话"
        confirm={async () => {
          if (
            clearRevision === null ||
            !(await submit({ action: "clear", revision: clearRevision }))
          )
            return false;
          requestAnimationFrame(() => input.current?.focus());
          return true;
        }}
      />
      {state ? (
        <ChatHistory
          messages={history}
          pending={sending || state.pending}
          onSelectPrompt={send}
          disabled={busy}
          onAnswer={(questionId, answer) =>
            void submit({ action: "answer", revision: state.revision, questionId, answer })
          }
        />
      ) : (
        <div className="scroll thread" role="status">
          {error ? (
            <Button variant="tertiary" onPress={() => void reload()}>
              重新加载对话
            </Button>
          ) : (
            "正在读取对话…"
          )}
        </div>
      )}
      {preview && (
        <div className="preview">
          <strong>批量改期 · {preview.titles.length} 条</strong>
          <p>
            {preview.date} · {preview.titles.join("、")}
          </p>
          <Button size="sm" isDisabled={busy} onPress={() => applyPreview("confirm")}>
            确认改期
          </Button>{" "}
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={busy}
            onPress={() => applyPreview("cancel")}
          >
            取消
          </Button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {error && <p role="alert">{error}</p>}
        <TextArea
          variant="secondary"
          ref={input}
          maxLength={16000}
          value={draft}
          readOnly={busy}
          aria-label="消息"
          placeholder="告诉小明你想做什么…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              void send(draft);
            }
          }}
        />
        <Button
          className="send"
          type="submit"
          size="sm"
          isIconOnly
          isDisabled={busy || !draft.trim()}
          aria-label="发送消息"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="m21 3-6.3 17.5-3.8-7.4-7.4-3.8L21 3Z M10.9 13.1 21 3" />
          </svg>
        </Button>
      </form>
    </aside>
  );
}
