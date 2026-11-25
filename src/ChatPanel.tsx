import { useEffect, useRef, useState } from "react";
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
          <button
            className="clear-chat"
            disabled={busy}
            onClick={() => {
              if (window.confirm("清空这段对话？任务会保留。"))
                void submit({ action: "clear", revision: state.revision });
            }}
          >
            清空对话
          </button>
        )}
        <button className="mobile-only" onClick={close}>
          返回清单
        </button>
      </div>
      {state ? (
        <ChatHistory messages={history} pending={sending || state.pending} onSelectPrompt={send} />
      ) : (
        <div className="scroll thread" role="status">
          {error ? <button onClick={reload}>重新加载对话</button> : "正在读取对话…"}
        </div>
      )}
      {preview && (
        <div className="preview">
          <strong>批量改期 · {preview.titles.length} 条</strong>
          <p>
            {preview.date} · {preview.titles.join("、")}
          </p>
          <button disabled={busy} onClick={() => applyPreview("confirm")}>
            确认改期
          </button>{" "}
          <button disabled={busy} onClick={() => applyPreview("cancel")}>
            取消
          </button>
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
        <textarea
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
        <button disabled={busy || !draft.trim()} aria-label="发送消息">
          ↑
        </button>
      </form>
    </aside>
  );
}
