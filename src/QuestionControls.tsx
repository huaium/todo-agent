import { useState } from "react";
import type { ChatQuestion, QuestionAnswer } from "../shared/chat.ts";
import { Button } from "@heroui/react";
import { PlannerDate, PlannerTime } from "./ScheduleFields.tsx";

function DeadlineChoices({
  question,
  editing,
  open,
  dismiss,
}: {
  question: Extract<ChatQuestion, { kind: "deadline" }>;
  editing: boolean;
  open(date: string): void;
  dismiss(): void;
}) {
  return (
    <section className="deadline-choices" inert={editing}>
      <Button variant="secondary" size="sm" onPress={() => open(question.today)}>
        今天 · {question.today}
      </Button>
      <Button variant="tertiary" size="sm" onPress={() => open("")}>
        选日期和时间
      </Button>
      <Button variant="ghost" size="sm" onPress={dismiss}>
        暂不设置
      </Button>
    </section>
  );
}

export function QuestionControls({
  question: q,
  disabled,
  onAnswer,
}: {
  question: ChatQuestion;
  disabled: boolean;
  onAnswer(answer: QuestionAnswer): void;
}) {
  const initialDate = q.kind === "deadline" ? q.task.dueDate : null;
  const [editing, setEditing] = useState(!!initialDate);
  const [date, setDate] = useState(initialDate ?? "");
  const [time, setTime] = useState("");
  const dismiss = () => onAnswer({ kind: "dismiss" });
  const open = (value: string) => {
    setDate(value);
    setEditing(true);
  };
  return (
    <fieldset
      className="chat-question"
      disabled={disabled}
      aria-label={q.kind === "choice" ? "选择任务" : "设置截止时间"}
    >
      {q.kind === "choice" ? (
        <>
          {q.tasks.map((t) => (
            <Button
              variant="tertiary"
              isDisabled={disabled}
              className="task-choice"
              key={t.id}
              onPress={() => onAnswer({ kind: "choose", taskId: t.id })}
            >
              <strong>{t.title}</strong>
              <span>
                {t.list} ·{" "}
                {t.dueDate ? [t.dueDate, t.dueTime].filter(Boolean).join(" ") : "无截止日期"}
              </span>
            </Button>
          ))}
          <Button variant="ghost" size="sm" onPress={dismiss}>
            取消
          </Button>
        </>
      ) : (
        <>
          {!initialDate && (
            <DeadlineChoices question={q} editing={editing} open={open} dismiss={dismiss} />
          )}
          {editing && (
            <form
              className={initialDate ? undefined : "deadline-editor-enter"}
              onSubmit={(e) => {
                e.preventDefault();
                onAnswer({ kind: "deadline", date, ...(time && { time }) });
              }}
            >
              {initialDate ? (
                <span>
                  {initialDate} · {q.timeZone}
                </span>
              ) : (
                <PlannerDate
                  label="截止日期"
                  zone={q.timeZone}
                  autoFocus
                  required
                  value={date}
                  disabled={disabled}
                  onChange={setDate}
                />
              )}
              <PlannerTime
                label={initialDate ? "截止时间" : "截止时间（可选）"}
                required={!!initialDate}
                disabled={disabled}
                value={time}
                onChange={setTime}
              />
              <footer>
                <Button
                  type="submit"
                  size="sm"
                  isDisabled={disabled || !date || (!!initialDate && !time)}
                >
                  {initialDate ? "保存时间" : "保存"}
                </Button>
                <Button variant="ghost" size="sm" onPress={dismiss}>
                  {initialDate ? "仅设日期" : "取消"}
                </Button>
              </footer>
            </form>
          )}
        </>
      )}
    </fieldset>
  );
}
