import { useState } from "react";
import { AnimatePresence, useIsPresent } from "motion/react";
import * as m from "motion/react-m";
import type { ChatQuestion, QuestionAnswer } from "../shared/chat.ts";
import { Button } from "@heroui/react";
import { PlannerDate, PlannerTime } from "./ScheduleFields.tsx";

function DeadlineChoices({
  question,
  open,
  dismiss,
}: {
  question: Extract<ChatQuestion, { kind: "deadline" }>;
  open(date: string): void;
  dismiss(): void;
}) {
  const present = useIsPresent();
  return (
    <m.section className="deadline-choices" inert={!present} exit={{ opacity: 0 }}>
      <Button variant="secondary" size="sm" onPress={() => open(question.today)}>
        今天 · {question.today}
      </Button>
      <Button variant="secondary" size="sm" onPress={() => open(question.tomorrow)}>
        明天 · {question.tomorrow}
      </Button>
      <Button variant="tertiary" size="sm" onPress={() => open("")}>
        选日期和时间
      </Button>
      <Button variant="ghost" size="sm" onPress={dismiss}>
        暂不设置
      </Button>
    </m.section>
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
        <AnimatePresence initial={false}>
          {editing ? (
            <m.form
              key="editor"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
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
            </m.form>
          ) : (
            <DeadlineChoices key="choices" question={q} open={open} dismiss={dismiss} />
          )}
        </AnimatePresence>
      )}
    </fieldset>
  );
}
