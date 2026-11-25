import { useEffect, useState } from "react";
import { Button, Checkbox, Dropdown } from "@heroui/react";
import {
  inbox,
  offsetDate,
  repeatLabels,
  type Planner,
  type PlannerTask,
} from "../shared/planner.ts";
import type { Action } from "./planner-client.ts";
interface Props {
  items: PlannerTask[];
  data: Planner;
  view: string;
  today: string;
  open(id: string): void;
  act: Action;
}
export function TaskList({ items, data, view, today, open, act }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<{ text: string }>();
  useEffect(() => {
    if (!confirmation) return;
    const timer = window.setTimeout(() => setConfirmation(undefined), 2600);
    return () => window.clearTimeout(timer);
  }, [confirmation]);
  const groups = new Map<string, PlannerTask[]>();
  for (const task of items) {
    const group =
      view === "today"
        ? task.dueDate! < today
          ? "已逾期"
          : "今天到期"
        : view === "upcoming"
          ? task.dueDate!
          : task.done
            ? "已完成"
            : "待办";
    const list = groups.get(group) ?? [];
    list.push(task);
    groups.set(group, list);
  }
  const order = [...groups.keys()].sort((a, b) =>
    view === "today"
      ? Number(a !== "已逾期") - Number(b !== "已逾期")
      : view === "upcoming"
        ? a.localeCompare(b)
        : Number(a === "已完成") - Number(b === "已完成"),
  );
  const patch = (id: string, changes: object) => act("planner/tasks/" + id, "PATCH", { changes });
  async function toggleDone(task: PlannerTask) {
    if (await patch(task.id, { done: !task.done }))
      setConfirmation({ text: (task.done ? "已重新打开「" : "已完成「") + task.title + "」" });
  }
  const byParent = new Map<string, PlannerTask[]>();
  for (const t of data.tasks) {
    if (t.parentId) {
      const siblings = byParent.get(t.parentId) ?? [];
      siblings.push(t);
      byParent.set(t.parentId, siblings);
    }
  }
  function render(task: PlannerTask, ancestors: Set<string>) {
    const children = (byParent.get(task.id) ?? []).filter((t) => !ancestors.has(t.id));
    const list = data.lists.find((l) => l.id === (task.listId ?? inbox));
    const meta = [
      view !== "list:" + list?.id && list?.name,
      task.repeat && repeatLabels[task.repeat],
      ...(task.tags ?? []).map((tag) => "#" + tag),
    ].filter(Boolean);
    return (
      <li key={task.id}>
        <div className={"task-row" + (task.done ? " completed" : "")}>
          <Checkbox
            className="circle-check"
            isSelected={task.done}
            aria-label={(task.done ? "重新打开" : "完成") + task.title}
            onChange={() => void toggleDone(task)}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
            </Checkbox.Content>
          </Checkbox>
          <div className="row-text">
            <Button variant="ghost" className="title-button" onPress={() => open(task.id)}>
              {task.title}
            </Button>
            {(meta.length > 0 || children.length > 0) && (
              <div className="metadata">
                {meta.join(" · ")}{" "}
                {children.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={expanded.has(task.id)}
                    onPress={() =>
                      setExpanded((old) => {
                        const next = new Set(old);
                        if (!next.delete(task.id)) next.add(task.id);
                        return next;
                      })
                    }
                  >
                    {expanded.has(task.id) ? "▾" : "▸"} {children.length} 个子任务
                  </Button>
                )}
              </div>
            )}
          </div>
          {task.dueDate && (
            <time className={task.dueDate < today && !task.done ? "overdue" : ""}>
              {task.dueDate === today ? "今天" : task.dueDate.slice(5)} {task.dueTime}
            </time>
          )}
          <Button
            variant="ghost"
            isIconOnly
            size="sm"
            className={"star" + (task.starred ? " active" : "")}
            aria-label={"星标" + task.title}
            aria-pressed={!!task.starred}
            onPress={() => void patch(task.id, { starred: !task.starred })}
          >
            {task.starred ? "★" : "☆"}
          </Button>
          <Dropdown>
            <Button variant="ghost" isIconOnly size="sm" aria-label={"操作" + task.title}>
              ···
            </Button>
            <Dropdown.Popover>
              <Dropdown.Menu aria-label="任务操作">
                <Dropdown.Item id="edit" onAction={() => open(task.id)}>
                  编辑详情
                </Dropdown.Item>
                <Dropdown.Item
                  id="tomorrow"
                  onAction={() => void patch(task.id, { dueDate: offsetDate(today, 1) })}
                >
                  明天
                </Dropdown.Item>
                <Dropdown.Item
                  id="unschedule"
                  onAction={() => void patch(task.id, { dueDate: null })}
                >
                  移除截止日期
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
        {expanded.has(task.id) && children.length > 0 && (
          <ul className="nested">
            {children.map((t) => render(t, new Set([...ancestors, task.id])))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <>
      {items.length === 0 && (
        <div className="empty-list">
          <span aria-hidden="true">✓</span>
          <h3>{view === "today" ? "今天没有到期任务" : "没有符合条件的任务"}</h3>
        </div>
      )}
      {order.map((key) => {
        const rows = groups.get(key)!;
        const ids = new Set(rows.map((t) => t.id));
        return (
          <section className="task-section" data-overdue={key === "已逾期" || undefined} key={key}>
            <h2>
              {key} <small>{rows.length}</small>
            </h2>
            <ul>
              {rows
                .filter((t) => !t.parentId || !ids.has(t.parentId))
                .map((t) => render(t, new Set()))}
            </ul>
          </section>
        );
      })}
      <div className="completion-status" role="status">
        {confirmation && <span>{confirmation.text}</span>}
      </div>
    </>
  );
}
