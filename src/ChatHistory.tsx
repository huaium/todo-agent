import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, QuestionAnswer, TaskCard } from "../shared/chat.ts";
import { ChatTaskCard, type OpenChatTask } from "./ChatTaskCard.tsx";
import { QuestionControls } from "./QuestionControls.tsx";
import { Button, Spinner } from "@heroui/react";

const examplePrompts = ["帮我记一下买牛奶", "看看我的待办", "今天有哪些任务到期？"];

function AssistantReply({
  message,
  current,
  disabled,
  onAnswer,
  openTask,
}: Pick<ChatHistoryProps, "disabled" | "onAnswer" | "openTask"> & {
  message: ChatMessage;
  current: boolean;
}) {
  const q = message.question;
  const controls = current && q && (
    <QuestionControls
      key={q.id}
      question={q}
      disabled={disabled}
      onAnswer={(answer) => onAnswer(q.id, answer)}
    />
  );
  const legacy = message.createdTasks;
  const cards: TaskCard[] =
    message.presentation?.cards ??
    (legacy
      ? [{ kind: "created", tasks: legacy.map((task) => ({ ...task, list: "", done: false })) }]
      : []);
  const attached =
    q?.kind === "deadline" ? cards.findIndex((c) => c.tasks.some((t) => t.id === q.task.id)) : -1;
  let text = cards.length ? message.presentation?.note : message.content;
  if (legacy && !message.presentation) {
    // Older batch receipts put additional outcomes on the lines following their summary.
    text = message.content.startsWith(`已添加 ${legacy.length} 项任务。`)
      ? message.content.split("\n").slice(1).join("\n")
      : message.content;
  }
  return (
    <>
      {text && (!controls || attached !== -1) && <div>{text}</div>}
      {cards.map((card, i) => (
        <ChatTaskCard key={i} card={card} openTask={openTask}>
          {i === attached && q?.kind === "deadline" && (
            <div className="card-question">
              <p>{q.task.dueDate ? "要设具体时间吗？" : "什么时候需要完成？"}</p>
              {controls}
            </div>
          )}
        </ChatTaskCard>
      ))}
      {controls && attached === -1 && (
        <section className="chat-task-card chat-prompt">
          <p>{message.content}</p>
          {controls}
        </section>
      )}
    </>
  );
}

interface ChatHistoryProps {
  openTask: OpenChatTask;
  children: ReactNode;
  scrollActions: boolean;
  messages: ChatMessage[];
  activeQuestionId?: string;
  pending: boolean;
  onSelectPrompt: (prompt: string) => void;
  disabled: boolean;
  onAnswer(id: string, answer: QuestionAnswer): void;
}

export function ChatHistory({
  openTask,
  children,
  scrollActions,
  messages,
  activeQuestionId,
  pending,
  onSelectPrompt,
  disabled,
  onAnswer,
}: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const activeIndex = activeQuestionId
    ? messages.findLastIndex((message) => message.question?.id === activeQuestionId)
    : -1;
  const [restoredCount, setRestoredCount] = useState(messages.length);
  if (messages.length < restoredCount) setRestoredCount(messages.length);
  useEffect(() => {
    const el = viewport.current;
    if (el && (following.current || messages.at(-1)?.role === "user"))
      el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  return (
    <>
      <div
        className="scroll"
        ref={viewport}
        onScroll={({ currentTarget: el }) => {
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {messages.length === 0 ? (
          <section className="welcome">
            <h2>今天想安排什么？</h2>
            <div className="examples">
              {examplePrompts.map((prompt) => (
                <Button variant="tertiary" key={prompt} onPress={() => onSelectPrompt(prompt)}>
                  {prompt}
                  <span aria-hidden="true">↗</span>
                </Button>
              ))}
            </div>
          </section>
        ) : (
          <div className="thread" role="log" aria-label="对话记录" aria-live="polite">
            {messages.map((message, index) => (
              <div
                key={index}
                className={`message ${message.role}`}
                role="group"
                aria-label={message.role === "user" ? "发出的消息" : "收到的回复"}
                data-new={index >= restoredCount || undefined}
              >
                {message.role === "user" ? (
                  <div>{message.content}</div>
                ) : (
                  <AssistantReply
                    message={message}
                    current={index === activeIndex}
                    openTask={openTask}
                    disabled={disabled}
                    onAnswer={onAnswer}
                  />
                )}
              </div>
            ))}
            {pending && (
              <p className="reply-pending" role="status">
                <Spinner size="sm" aria-hidden="true" />
                正在回复…
              </p>
            )}
          </div>
        )}
        {scrollActions && children}
      </div>
      {!scrollActions && children}
    </>
  );
}
