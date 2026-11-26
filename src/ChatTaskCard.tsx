import { useId, useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import type { TaskCard } from "../shared/chat.ts";

export type OpenChatTask = (id: string) => Promise<string | undefined>;
const headings = {
  created: "已添加",
  updated: "已更新",
  completed: "已完成",
  deleted: "已移入回收站",
  query: "查询结果",
};

export function ChatTaskCard({
  card,
  children,
  openTask,
}: {
  card: TaskCard;
  children?: ReactNode;
  openTask: OpenChatTask;
}) {
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const { kind, tasks } = card;
  const count = tasks.length;
  const initial = kind === "query" ? 3 : count === 1 ? 1 : 0;
  const rows = expanded ? tasks : tasks.slice(0, initial);
  const heading = card.heading ?? headings[kind] + (count > 1 ? ` ${count} 项任务` : "");
  return (
    <section className="chat-task-card" aria-label={heading}>
      <header>
        <span aria-hidden="true" className="card-mark">
          {kind === "query" ? "≡" : "✓"}
        </span>
        {heading}
      </header>
      <ul id={listId}>
        {rows.map((task) => {
          const deadline = [task.dueDate, task.dueTime].filter(Boolean).join(" ");
          const metadata = [
            task.list,
            kind === "query" && (task.done ? "已完成" : "待办"),
            !task.previousDeadline && (deadline || (count > 1 && "未设日期")),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={task.id}>
              {kind === "deleted" ? (
                <strong>{task.title}</strong>
              ) : (
                <button
                  type="button"
                  className="card-task-link"
                  onClick={async () => {
                    setNotice("");
                    setNotice((await openTask(task.id)) ?? "");
                  }}
                >
                  <strong>{task.title}</strong>
                  <span aria-hidden="true">›</span>
                </button>
              )}
              {metadata && <small>{metadata}</small>}
              {task.previousDeadline && (
                <p className="card-deadline">
                  截止 · <del>{task.previousDeadline}</del> → {deadline || "未设日期"}
                </p>
              )}
              {task.details?.map((detail) => (
                <small key={detail}>{detail}</small>
              ))}
            </li>
          );
        })}
      </ul>
      {count > initial && (
        <Button
          variant="tertiary"
          size="sm"
          aria-expanded={expanded}
          aria-controls={listId}
          onPress={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : initial ? `展开其余 ${count - initial} 项` : `查看 ${count} 项`}
        </Button>
      )}
      {card.more && <small>还有更多任务，可继续询问下一页。</small>}
      {notice && <p role="status">{notice}</p>}
      {children}
    </section>
  );
}
