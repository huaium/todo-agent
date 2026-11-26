import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, CreatedTask, QuestionAnswer } from "../shared/chat.ts";
import { QuestionControls } from "./QuestionControls.tsx";
import { Button, Spinner } from "@heroui/react";

const examplePrompts = ["帮我记一下买牛奶", "看看我的待办", "今天有哪些任务到期？"];

function CreatedTaskList({ tasks }: { tasks: CreatedTask[] }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  return (
    <section className="chat-receipt">
      <Button
        size="sm"
        variant="tertiary"
        aria-expanded={expanded}
        aria-controls={listId}
        onPress={() => setExpanded(!expanded)}
      >
        {expanded ? "收起" : "查看"} {tasks.length} 项
      </Button>
      <ul id={listId} hidden={!expanded}>
        {tasks.map(({ id, title, dueDate, dueTime }) => (
          <li key={id}>
            <span>{title}</span>
            <small>{[dueDate, dueTime].filter(Boolean).join(" ") || "未设日期"}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ChatHistoryProps {
  children: ReactNode;
  scrollActions: boolean;
  messages: ChatMessage[];
  pending: boolean;
  onSelectPrompt: (prompt: string) => void;
  disabled: boolean;
  onAnswer(id: string, answer: QuestionAnswer): void;
}

export function ChatHistory({
  children,
  scrollActions,
  messages,
  pending,
  onSelectPrompt,
  disabled,
  onAnswer,
}: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
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
                <div>{message.content}</div>
                {message.role === "assistant" && message.createdTasks && (
                  <CreatedTaskList tasks={message.createdTasks} />
                )}
                {index === messages.length - 1 &&
                  message.role === "assistant" &&
                  message.question && (
                    <QuestionControls
                      key={message.question.id}
                      question={message.question}
                      disabled={disabled}
                      onAnswer={(answer) => onAnswer(message.question!.id, answer)}
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
