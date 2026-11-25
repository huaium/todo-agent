import { useState } from "react";
import { Button } from "@heroui/react";
import type { BinItem, Planner } from "../shared/planner.ts";
import type { Action } from "./planner-client.ts";
import { TaskFeedback, type TaskNotice } from "./TaskFeedback.tsx";

interface Props {
  items: BinItem[] | null;
  planner: Planner;
  query: string;
  act: Action;
}

export function TaskBin({ items, planner, query, act }: Props) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const [notice, setNotice] = useState<TaskNotice>();
  const format = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: planner.timeZone ?? undefined,
  });
  const listName = (id: string) => planner.lists.find((list) => list.id === id)?.name ?? "收件箱";
  const search = query.trim().toLocaleLowerCase();
  const matches = items?.filter((item) =>
    [item.title, listName(item.listId)].some((text) => text.toLocaleLowerCase().includes(search)),
  );
  async function restore(item: BinItem) {
    setRestoring(item.id);
    if (
      await act("planner/bin/" + encodeURIComponent(item.id) + "/restore", "POST", {
        deletedAt: item.deletedAt,
      })
    )
      setNotice({ text: "已恢复「" + item.title + "」。" });
    setRestoring(null);
  }
  return (
    <div className="list-scroll">
      <div className="view-head">
        <div>
          <h1>回收站</h1>
          <p>任务自删除起保留 30 天，到期后自动清除。</p>
        </div>
      </div>
      {!matches ? (
        <p role="status">正在读取回收站…</p>
      ) : matches.length === 0 ? (
        <div className="empty-list">
          <h3>{search ? "没有符合条件的任务" : "回收站为空"}</h3>
        </div>
      ) : (
        <section className="task-section" aria-label="已删除的任务">
          <ul>
            {matches.map((item) => (
              <li key={item.id}>
                <div className="task-row">
                  <div className="row-text bin-row-text">
                    <strong>{item.title}</strong>
                    <div className="metadata">
                      {listName(item.listId)} ·{" "}
                      <time dateTime={new Date(item.expiresAt).toISOString()}>
                        {format.format(item.expiresAt)}
                      </time>{" "}
                      清除
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={"恢复" + item.title}
                    isDisabled={restoring !== null}
                    isPending={restoring === item.id}
                    onPress={() => void restore(item)}
                  >
                    恢复
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <TaskFeedback notice={notice} />
    </div>
  );
}
