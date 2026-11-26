import { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Label, TextArea } from "@heroui/react";
import { ConfirmAction } from "./PlannerControls.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { useConversation } from "./chat-client.ts";
import { KeyHint } from "./KeyboardHints.tsx";
import type { ApprovalMode, ChatMessage, ViewContext, SortChange } from "../shared/chat.ts";
function sessionValue(key: string, value?: string) {
  try {
    if (value !== undefined) sessionStorage.setItem(key, value);
    else return sessionStorage.getItem(key);
  } catch (error) {
    if (
      !(
        error instanceof DOMException &&
        ["SecurityError", "QuotaExceededError"].includes(error.name)
      )
    )
      throw error;
  }
}
function tabIdentity() {
  const saved = sessionValue("planner-chat-tab");
  if (saved) return saved;
  const id = crypto.getRandomValues(new Uint32Array(4)).join("-");
  sessionValue("planner-chat-tab", id);
  return id;
}
const modeLabels = { allow: "全部允许", cautious: "审慎模式" } satisfies Record<
  ApprovalMode,
  string
>;
export function ChatPanel({
  context,
  changed,
  close,
  sortContext,
  applySort,
}: {
  context: ViewContext;
  changed(): Promise<void>;
  close(): void;
  sortContext: Omit<NonNullable<ViewContext["sorting"]>, "tab">;
  applySort(change: SortChange): void;
}) {
  const [tab] = useState(tabIdentity);
  const [initialTurn] = useState(() => Number(sessionValue("planner-applied-sort:" + tab)) || 0);
  const appliedTurn = useRef(initialTurn);
  const { state, active, error, reload, submit } = useConversation();
  const [draft, setDraft] = useState("");
  const [clearRevision, setClearRevision] = useState<number | null>(null);
  const busy = !state || !!active || state.pending;
  const sending = active?.action === "send" && active.revision === state?.revision;
  const history: ChatMessage[] = sending
    ? [...state!.messages, { role: "user", content: active.text }]
    : (state?.messages ?? []);
  const preview = !sending && state?.preview;
  const mode = state?.approvalMode ?? "allow";
  const approval = state?.approval;
  const input = useRef<HTMLTextAreaElement>(null);
  const seenRevision = useRef<number>(undefined);
  useEffect(() => {
    if (!state || seenRevision.current === state.revision) return;
    const firstLoad = seenRevision.current === undefined;
    seenRevision.current = state.revision;
    // A tab may have refreshed or navigated while the agent was awaiting approval.
    for (const { sortChange } of state.messages) {
      if (sortChange?.tab !== tab || sortChange.turn <= appliedTurn.current) continue;
      applySort(sortChange);
      appliedTurn.current = sortChange.turn;
      sessionValue("planner-applied-sort:" + tab, String(sortChange.turn));
    }
    if (!firstLoad && !state.pending) void changed();
  }, [state, changed, tab, applySort]);
  async function send(text: string) {
    if (!text.trim() || !state || busy) return;
    setDraft("");
    const accepted = await submit({
      action: "send",
      text: text.trim(),
      context: { ...context, sorting: { ...sortContext, tab } },
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
        <Dropdown>
          <Button
            variant="tertiary"
            size="sm"
            className="approval-mode"
            isDisabled={busy}
            aria-label={`审批模式：${modeLabels[mode]}`}
          >
            {state ? modeLabels[mode] : "审批模式"} <span aria-hidden="true">▾</span>
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label="审批模式"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[mode]}
              onAction={(key) => {
                if (state && !busy && key !== mode && (key === "allow" || key === "cautious"))
                  void submit({ action: "setApprovalMode", revision: state.revision, mode: key });
              }}
            >
              {(["allow", "cautious"] as const).map((key) => (
                <Dropdown.Item key={key} id={key} textValue={modeLabels[key]}>
                  <Label>{modeLabels[key]}</Label>
                  <Dropdown.ItemIndicator />
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
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
          pending={!approval && (sending || state.pending)}
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
      {state && approval && (
        <section className="preview approval-card" aria-label="待审批的更改">
          <strong>等待审批</strong>
          <div className="approval-details" aria-live="polite">
            <p>{approval.title}</p>
            {approval.details.length > 0 && (
              <ul>
                {approval.details.map((detail, i) => (
                  <li key={i}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
          <Button
            size="sm"
            isDisabled={!!active}
            onPress={() =>
              void submit({
                action: "review",
                revision: state.revision,
                token: approval.token,
                allow: true,
              })
            }
          >
            允许此次更改
          </Button>{" "}
          <Button
            size="sm"
            variant="tertiary"
            isDisabled={!!active}
            onPress={() =>
              void submit({
                action: "review",
                revision: state.revision,
                token: approval.token,
                allow: false,
              })
            }
          >
            取消
          </Button>
        </section>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {error && <p role="alert">{error}</p>}
        <div className="chat-key-hints">
          <KeyHint keys="F6">切换面板</KeyHint>
          {!busy && (
            <>
              <KeyHint keys="Enter">发送</KeyHint>
              <KeyHint keys="Shift Enter">换行</KeyHint>
            </>
          )}
        </div>
        <TextArea
          variant="secondary"
          ref={input}
          maxLength={16000}
          value={draft}
          readOnly={busy}
          aria-label="消息"
          aria-keyshortcuts="F6"
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
