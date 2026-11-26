import type { ChatQuestion } from "./chat.ts";

type Choice = Extract<ChatQuestion, { kind: "choice" }>["tasks"][number];
function locationAndDate(task: Choice) {
  return [
    task.list,
    ...(task.parentPath ?? []),
    task.dueDate ? [task.dueDate, task.dueTime].filter(Boolean).join(" ") : "无截止日期",
  ].join(" · ");
}
export function choiceDescription(task: Choice, choices: Choice[]) {
  const description = locationAndDate(task);
  const identical = choices.some(
    (other) =>
      other.id !== task.id && other.title === task.title && locationAndDate(other) === description,
  );
  return identical ? description + " · ID " + task.id : description;
}
