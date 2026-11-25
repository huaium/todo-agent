import { useEffect, useRef, useState } from "react";
import type { ChatMessage, QuestionAnswer } from "../shared/chat.ts";
import { QuestionControls } from "./QuestionControls.tsx";
import { Button, Spinner } from "@heroui/react";

const examplePrompts = ["帮我记一下买牛奶", "看看我的待办", "今天有哪些任务到期？"];

interface ChatHistoryProps {
  messages: ChatMessage[];
  pending: boolean;
  onSelectPrompt: (prompt: string) => void;
  disabled: boolean;
  onAnswer(id: string, answer: QuestionAnswer): void;
}

export function ChatHistory({
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
    <div
      className="scroll"
      ref={viewport}
      onScroll={({ currentTarget: el }) => {
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      {messages.length === 0 ? (
        <section className="welcome">
          <img src="/logo.png" alt="" />
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
              data-new={index >= restoredCount || undefined}
            >
              <small>{message.role === "user" ? "你" : "小明智能体"}</small>
              <div>{message.content}</div>
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
    </div>
  );
}
