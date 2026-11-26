import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";
import { Button, Dropdown, Label, Modal, TextArea } from "@heroui/react";
import { ConfirmAction } from "./PlannerControls.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { ChatSettings, useSendShortcut } from "./ChatSettings.tsx";
import { ModelDownload, useSpeechModel } from "./speech/ModelDownload.tsx";
import { useDictation } from "./speech/useDictation.ts";
import { useConversation } from "./chat-client.ts";
import { chatKeys, KeyHint } from "./KeyboardHints.tsx";
import { IconButton } from "./IconButton.tsx";
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
  openTask,
  context,
  changed,
  focusRef,
  sortContext,
  applySort,
}: {
  openTask(id: string): Promise<string | undefined>;
  context: ViewContext;
  changed(): Promise<void>;
  focusRef: Ref<() => void>;
  sortContext: Omit<NonNullable<ViewContext["sorting"]>, "tab">;
  applySort(change: SortChange): void;
}) {
  const [tab] = useState(tabIdentity);
  const [initialTurn] = useState(() => Number(sessionValue("planner-applied-sort:" + tab)) || 0);
  const appliedTurn = useRef(initialTurn);
  const { state, active, error, reload, submit } = useConversation();
  const [draft, setDraft] = useState("");
  const [shiftToSend, chooseSendShortcut] = useSendShortcut();
  const speechModel = useSpeechModel();
  const [showModel, setShowModel] = useState(false);
  const [clearRevision, setClearRevision] = useState<number | null>(null);
  const busy = !state || !!active || state.pending;
  const sending = active?.action === "send" && active.revision === state?.revision;
  const history: ChatMessage[] = sending
    ? [...state!.messages, { role: "user", content: active.text }]
    : (state?.messages ?? []);
  const preview = state?.preview;
  const expiresAt = preview ? preview.expiresAt : undefined;
  const [expiredAt, setExpiredAt] = useState<number>();
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(
      () => setExpiredAt(expiresAt),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const expired = !!expiresAt && (expiredAt === expiresAt || Date.now() >= expiresAt);
  const mode = state?.approvalMode ?? "allow";
  const approval = state?.approval;
  const input = useRef<HTMLTextAreaElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const [narrowScreen] = useState(() => matchMedia("(max-width: 760px)"));
  const [mobile, setMobile] = useState(narrowScreen.matches);
  const [sheetOpen, setSheetOpen] = useState(false);
  function focusComposer() {
    if (mobile && !sheetOpen) {
      launcher.current?.focus({ preventScroll: true });
      // Mount and focus during the tap so mobile keyboards recognize the user gesture.
      flushSync(() => setSheetOpen(true));
    }
    input.current?.focus({ preventScroll: true });
  }
  useImperativeHandle(focusRef, () => focusComposer);
  const voice = useDictation((text) => {
    setDraft((previous) =>
      previous && !/\s$/u.test(previous) ? previous + " " + text : previous + text,
    );
    if (input.current?.offsetParent) input.current.focus();
  });
  const voiceActive = voice.phase !== "idle";
  const onBreakpointChange = useEffectEvent(() => {
    setMobile(narrowScreen.matches);
    setSheetOpen(false);
    if (narrowScreen.matches) {
      if (voiceActive) voice.cancel();
      setShowModel(false);
      setClearRevision(null);
    }
  });
  useEffect(() => {
    narrowScreen.addEventListener("change", onBreakpointChange);
    return () => narrowScreen.removeEventListener("change", onBreakpointChange);
  }, [narrowScreen]);
  const tooLong = draft.length > 16000;
  function openModel() {
    voice.cancel();
    setShowModel(true);
  }
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
    if (!text.trim() || text.trim().length > 16000 || !state || busy || voiceActive) return;
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
  function dismissSheet() {
    if (voiceActive) voice.cancel();
    setSheetOpen(false);
  }
  const content = (
    <>
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
        <ChatSettings
          shiftToSend={shiftToSend}
          onChange={chooseSendShortcut}
          manageSpeechModel={voiceActive ? undefined : openModel}
        />
        {!!state?.messages.length && (
          <IconButton
            size="sm"
            variant="ghost"
            className="clear-chat"
            icon="trash"
            label="清空对话"
            isDisabled={busy}
            onPress={() => setClearRevision(state.revision)}
          />
        )}
        {mobile && (
          <Button isIconOnly size="sm" variant="ghost" aria-label="关闭聊天" onPress={dismissSheet}>
            <span aria-hidden="true">×</span>
          </Button>
        )}
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
      <ModelDownload model={speechModel} open={showModel} close={() => setShowModel(false)} />
      {state ? (
        <ChatHistory
          openTask={async (id) => {
            const error = await openTask(id);
            if (!error && mobile) dismissSheet();
            return error;
          }}
          messages={history}
          activeQuestionId={sending ? undefined : state.activeQuestionId}
          pending={!approval && (sending || state.pending)}
          onSelectPrompt={send}
          disabled={busy || voiceActive}
          scrollActions={mobile}
          onAnswer={(questionId, answer) =>
            void submit({ action: "answer", revision: state.revision, questionId, answer })
          }
        >
          {preview && expired && (
            <p className="preview chat-action-card" role="status">
              改期预览已过期，请重新预览。
            </p>
          )}
          {preview && !expired && (
            <div className="preview chat-action-card">
              <strong>待确认改期 · {preview.titles.length} 项</strong>
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
            <section className="preview approval-card chat-action-card" aria-label="待审批的更改">
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
        </ChatHistory>
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
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        {error && <p role="alert">{error}</p>}
        {voice.error && <p role="alert">{voice.error}</p>}
        {tooLong && <p role="alert">请将草稿缩短至 16000 字符以内再发送。</p>}
        {voiceActive && (
          <div className="voice-status">
            <span role="status">
              {voice.phase === "recording"
                ? "正在录音，最长 30 秒"
                : voice.phase === "permission"
                  ? "等待麦克风权限…"
                  : "正在识别中文…"}
            </span>
            <Button type="button" size="sm" variant="ghost" onPress={voice.cancel}>
              取消
            </Button>
          </div>
        )}
        <div className="chat-key-hints">
          <KeyHint keys={chatKeys}>聚焦聊天</KeyHint>
          {!busy && !voiceActive && (
            <>
              <KeyHint keys={shiftToSend ? "Shift Enter" : "Enter"}>发送</KeyHint>
              <KeyHint keys={shiftToSend ? "Enter" : "Shift Enter"}>换行</KeyHint>
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
          aria-keyshortcuts="Control+/ Meta+/"
          placeholder="告诉小明你想做什么…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              e.shiftKey === shiftToSend &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !e.nativeEvent.isComposing &&
              e.nativeEvent.keyCode !== 229
            ) {
              e.preventDefault();
              if (!e.repeat) void send(draft);
            }
          }}
        />
        <div className="composer-actions">
          <IconButton
            icon={voice.phase === "recording" ? "stop" : "microphone"}
            label={voice.phase === "recording" ? "结束录音并转写" : "语音输入"}
            size="sm"
            variant="ghost"
            type="button"
            className={voice.phase === "recording" ? "voice-recording" : undefined}
            isDisabled={busy || voice.phase === "recognizing" || voice.phase === "permission"}
            onPress={() => {
              if (voice.phase === "recording") voice.finish();
              else if (speechModel.state.status !== "ready") openModel();
              else void voice.record();
            }}
          />
          <Button
            className="send"
            type="submit"
            size="sm"
            isIconOnly
            isDisabled={busy || voiceActive || tooLong || !draft.trim()}
            aria-label="发送消息"
            aria-keyshortcuts={shiftToSend ? "Shift+Enter" : "Enter"}
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
        </div>
      </form>
    </>
  );
  if (!mobile)
    return (
      <aside className="chat-pane" aria-label="小明对话">
        {content}
      </aside>
    );
  return (
    <>
      <div className="chat-dock">
        <Button
          ref={launcher}
          className="chat-launcher"
          variant="tertiary"
          aria-label="打开小明智能体对话"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-keyshortcuts="Control+/ Meta+/"
          onPress={focusComposer}
        >
          <img src="/logo.png" alt="" />
          <strong>小明智能体</strong>
          <span>{draft.trim() || "输入消息…"}</span>
        </Button>
      </div>
      <Modal.Backdrop
        className="chat-backdrop"
        isOpen={sheetOpen}
        isDismissable
        onOpenChange={(open) => {
          if (!open) dismissSheet();
        }}
      >
        <Modal.Container className="chat-sheet-container" placement="bottom">
          <Modal.Dialog className="chat-pane chat-sheet" aria-label="小明对话">
            {content}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
