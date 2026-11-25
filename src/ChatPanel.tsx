import { useRef, useState } from "react";
import { ChatHistory } from "./ChatHistory.tsx";
import { requestReply } from "./chat-client.ts";
import type { ChatMessage, BulkPreview, ViewContext } from "../shared/chat.ts";
import type { Action } from "./planner-client.ts";
export function ChatPanel({
  context,
  changed,
  act,
  close,
}: {
  context: ViewContext;
  changed(): Promise<void>;
  act: Action;
  close(): void;
}) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<BulkPreview>();
  const input = useRef<HTMLTextAreaElement>(null);
  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    setPreview(undefined);
    setDraft("");
    const outgoing: ChatMessage[] = [...history, { role: "user", content: text.trim() }];
    setHistory(outgoing);
    try {
      const result = await requestReply(outgoing, context);
      setHistory([...outgoing, { role: "assistant", content: result.reply }]);
      setPreview(result.preview);
    } catch (e) {
      setHistory(history);
      setDraft(text);
      setError(e instanceof Error ? e.message : "发送失败。");
    } finally {
      await changed();
      setBusy(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }
  async function confirm() {
    if (!preview || busy) return;
    setBusy(true);
    if (await act("planner/reschedule/" + preview.token, "POST"))
      setHistory((h) => [
        ...h,
        {
          role: "assistant",
          content: `已将 ${preview.titles.length} 条任务改到 ${preview.date}。`,
        },
      ]);
    setPreview(undefined);
    setBusy(false);
  }
  return (
    <aside className="chat-pane" aria-label="小明对话">
      <div className="pane-head">
        <img src="/logo.png" alt="" />
        <strong>小明</strong>
        <button className="mobile-only" onClick={close}>
          返回清单
        </button>
      </div>
      <ChatHistory messages={history} pending={busy} onSelectPrompt={send} />
      {preview && (
        <div className="preview">
          <strong>批量改期 · {preview.titles.length} 条</strong>
          <p>
            {preview.date} · {preview.titles.join("、")}
          </p>
          <button disabled={busy} onClick={confirm}>
            确认改期
          </button>{" "}
          <button disabled={busy} onClick={() => setPreview(undefined)}>
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
