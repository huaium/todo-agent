import { useState } from "react";
import type { ChatQuestion, QuestionAnswer } from "../shared/chat.ts";

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
            <button
              className="task-choice"
              key={t.id}
              onClick={() => onAnswer({ kind: "choose", taskId: t.id })}
            >
              <strong>{t.title}</strong>
              <span>
                {t.list} ·{" "}
                {t.dueDate ? [t.dueDate, t.dueTime].filter(Boolean).join(" ") : "无截止日期"}
              </span>
            </button>
          ))}
          <button onClick={dismiss}>取消</button>
        </>
      ) : editing ? (
        <form
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
            <label>
              截止日期
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          )}
          <label>
            截止时间{!initialDate && "（可选）"}
            <input
              type="time"
              required={!!initialDate}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <footer>
            <button className="save-deadline" disabled={!date || (!!initialDate && !time)}>
              {initialDate ? "保存时间" : "保存"}
            </button>
            <button type="button" onClick={dismiss}>
              {initialDate ? "仅设日期" : "取消"}
            </button>
          </footer>
        </form>
      ) : (
        <>
          <button onClick={() => open(q.today)}>今天 · {q.today}</button>
          <button onClick={() => open(q.tomorrow)}>明天 · {q.tomorrow}</button>
          <button onClick={() => open("")}>选日期和时间</button>
          <button onClick={dismiss}>暂不设置</button>
        </>
      )}
    </fieldset>
  );
}
