import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MotionConfig, Reorder, useDragControls } from "motion/react";
import type { PlannerTask } from "../shared/planner.ts";

export interface RowControls {
  handle: ReactNode;
  moveUp?: () => void;
  moveDown?: () => void;
}
type RenderRow = (task: PlannerTask, controls?: RowControls) => ReactNode;
interface Props {
  rows: PlannerTask[];
  manual: boolean;
  className?: string;
  render: RenderRow;
  save(previous: string[], ordered: string[], task: PlannerTask): Promise<void>;
}
type Move = { id: string; previous: string[]; ordered: string[]; saving: boolean };
const sameOrder = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function SortableRow({
  task,
  help,
  render,
  moveUp,
  moveDown,
  begin,
  finish,
  cancel,
  busy,
  active,
  order,
}: {
  task: PlannerTask;
  help: string;
  render: RenderRow;
  moveUp?: () => void;
  moveDown?: () => void;
  begin(): void;
  finish(): void;
  cancel(): void;
  busy: boolean;
  active: boolean;
  order: string;
}) {
  const controls = useDragControls();
  const grabbed = useRef(false);
  return (
    <Reorder.Item
      value={task.id}
      layout="position"
      layoutDependency={order}
      className="sortable-row"
      data-moving={active || undefined}
      aria-label={task.title}
      aria-describedby={help}
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      onDragStart={begin}
      onDragEnd={(event) => (event.type === "pointercancel" ? cancel() : finish())}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (busy) {
          if (event.key !== "Tab") event.preventDefault();
          return;
        }
        if (event.key === " " && !event.repeat) {
          if (grabbed.current) finish();
          else begin();
          grabbed.current = !grabbed.current;
        } else if (event.key === "Escape" && grabbed.current) {
          grabbed.current = false;
          cancel();
        }
      }}
      onBlur={() => {
        if (grabbed.current) {
          grabbed.current = false;
          finish();
        }
      }}
    >
      {render(task, {
        moveUp,
        moveDown,
        handle: (
          <span
            className="reorder-grip"
            aria-hidden="true"
            title="拖动调整顺序"
            onPointerDown={(event) => {
              if (!busy && event.isPrimary && event.button === 0) controls.start(event);
            }}
          >
            <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor">
              <circle cx="3" cy="3" r="1.5" />
              <circle cx="9" cy="3" r="1.5" />
              <circle cx="3" cy="9" r="1.5" />
              <circle cx="9" cy="9" r="1.5" />
              <circle cx="3" cy="15" r="1.5" />
              <circle cx="9" cy="15" r="1.5" />
            </svg>
          </span>
        ),
      })}
    </Reorder.Item>
  );
}

export function ReorderTasks({ rows, manual, className, render, save }: Props) {
  const help = useId();
  const move = useRef<Move | null>(null);
  const [draft, setDraft] = useState<Move | null>(null);
  const ids = rows.map((t) => t.id);
  const byId = new Map(rows.map((task) => [task.id, task]));
  function update(next: Move | null) {
    move.current = next;
    setDraft(next);
  }
  useEffect(() => {
    // A filter or another tab may remove the grabbed row before it can deliver a drop.
    if (draft && !draft.saving && (!manual || !sameOrder(ids, draft.previous))) update(null);
  }, [draft, ids, manual]);
  function begin(id: string) {
    if (!move.current) update({ id, previous: ids, ordered: ids, saving: false });
  }
  function preview(ordered: string[]) {
    if (move.current && !move.current.saving) update({ ...move.current, ordered });
  }
  async function finish() {
    const current = move.current;
    if (!current || current.saving) return;
    const task = byId.get(current.id);
    if (task && sameOrder(current.previous, ids) && !sameOrder(current.previous, current.ordered)) {
      update({ ...current, saving: true });
      try {
        await save(current.previous, current.ordered, task);
      } finally {
        update(null);
      }
    } else update(null);
  }
  function step(index: number, offset: number) {
    if (move.current) return;
    const ordered = [...ids];
    ordered.splice(index + offset, 0, ...ordered.splice(index, 1));
    begin(ids[index]);
    preview(ordered);
    void finish();
  }
  if (!manual || rows.length < 2)
    return (
      <ul className={className}>
        {rows.map((task) => (
          <li key={task.id}>{render(task)}</li>
        ))}
      </ul>
    );
  const values = draft && sameOrder(ids, draft.previous) ? draft.ordered : ids;
  const order = draft?.ordered.join("/") ?? "";
  return (
    <MotionConfig reducedMotion="user">
      <span id={help} className="sr-only">
        空格抓取或放下任务，上下方向键移动，Esc 取消。
      </span>
      <Reorder.Group axis="y" className={className} values={values} onReorder={preview}>
        {values.map((id, i) => (
          <SortableRow
            key={id}
            task={byId.get(id)!}
            help={help}
            order={order}
            render={render}
            moveUp={!draft && i > 0 ? () => step(i, -1) : undefined}
            moveDown={!draft && i < values.length - 1 ? () => step(i, 1) : undefined}
            begin={() => begin(id)}
            finish={() => void finish()}
            cancel={() => update(null)}
            busy={!!draft?.saving}
            active={draft?.id === id && !draft.saving}
          />
        ))}
      </Reorder.Group>
    </MotionConfig>
  );
}
