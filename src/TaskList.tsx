import { useState } from "react";
import { Button, Checkbox, Dropdown, Label } from "@heroui/react";
import { inbox, repeatLabels, type Planner, type PlannerTask } from "../shared/planner.ts";
import type { Action } from "./planner-client.ts";
import { TaskFeedback, type TaskNotice } from "./TaskFeedback.tsx";
import { ReorderTasks, type RowControls } from "./ReorderTasks.tsx";
import type { SortChoice } from "./task-sort.ts";
interface Props {
  items: PlannerTask[];
  tasks: PlannerTask[];
  lists: Planner["lists"];
  view: string;
  sort: SortChoice;
  refresh(): Promise<void>;
  today: string;
  open(id: string): void;
  requestDelete(id: string): void;
  deleting: string | null;
  act: Action;
}
export function TaskList({
  items,
  tasks,
  lists,
  view,
  sort,
  refresh,
  today,
  open,
  requestDelete,
  deleting,
  act,
}: Props) {
  const manual = sort.method === "manual";
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<TaskNotice>();
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
        ? a.localeCompare(b) * (sort.method === "due" && sort.reverse ? -1 : 1)
        : Number(a === "已完成") - Number(b === "已完成"),
  );
  const patch = (id: string, changes: object) => act("planner/tasks/" + id, "PATCH", { changes });
  async function toggleDone(task: PlannerTask) {
    if (await patch(task.id, { done: !task.done }))
      setConfirmation({ text: (task.done ? "已重新打开「" : "已完成「") + task.title + "」" });
  }
  const byParent = new Map<string, PlannerTask[]>();
  for (const t of tasks) {
    if (t.parentId) {
      const siblings = byParent.get(t.parentId) ?? [];
      siblings.push(t);
      byParent.set(t.parentId, siblings);
    }
  }
  async function saveOrder(previous: string[], ordered: string[], task: PlannerTask) {
    if (await act("planner/tasks/order", "POST", { previous, ordered }))
      setConfirmation({ text: `「${task.title}」已移至第 ${ordered.indexOf(task.id) + 1} 位。` });
    else await refresh();
  }
  function render(task: PlannerTask, ancestors: Set<string>, controls?: RowControls) {
    const children = (byParent.get(task.id) ?? []).filter((t) => !ancestors.has(t.id));
    const list = lists.find((l) => l.id === (task.listId ?? inbox));
    const meta = [
      view !== "list:" + list?.id && list?.name,
      task.repeat && repeatLabels[task.repeat],
      ...(task.tags ?? []).map((tag) => "#" + tag),
    ].filter(Boolean);
    return (
      <>
        <div
          className={"task-row" + (task.done ? " completed" : "")}
          data-task-id={task.id}
          data-parent-row={ancestors.size ? [...ancestors].join("/") : undefined}
          data-row-action={deleting === task.id || undefined}
        >
          {controls?.handle}
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
            <Button
              variant="ghost"
              className="title-button"
              data-row-primary
              aria-keyshortcuts="ArrowUp ArrowDown Home End X"
              onPress={() => open(task.id)}
              onKeyDown={(event) => {
                if (
                  event.key.toLowerCase() !== "x" ||
                  event.ctrlKey ||
                  event.altKey ||
                  event.metaKey ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                )
                  return;
                event.preventDefault();
                if (!event.repeat) void toggleDone(task);
              }}
            >
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
            <span aria-hidden="true">{task.starred ? "★" : "☆"}</span>
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
                {controls?.moveUp && (
                  <Dropdown.Item id="move-up" onAction={controls.moveUp}>
                    上移一位
                  </Dropdown.Item>
                )}
                {controls?.moveDown && (
                  <Dropdown.Item id="move-down" onAction={controls.moveDown}>
                    下移一位
                  </Dropdown.Item>
                )}
                <Dropdown.Item
                  id="delete"
                  textValue="删除任务"
                  variant="danger"
                  onAction={() => requestDelete(task.id)}
                >
                  <Label>删除任务</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
        {expanded.has(task.id) && children.length > 0 && (
          <ReorderTasks
            className="nested"
            rows={children}
            manual={manual}
            save={saveOrder}
            render={(child, childControls) =>
              render(child, new Set([...ancestors, task.id]), childControls)
            }
          />
        )}
      </>
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
            <ReorderTasks
              key={view}
              rows={rows.filter((t) => !t.parentId || !ids.has(t.parentId))}
              manual={manual}
              save={saveOrder}
              render={(task, controls) => render(task, new Set(), controls)}
            />
          </section>
        );
      })}
      <TaskFeedback notice={confirmation} />
    </>
  );
}
