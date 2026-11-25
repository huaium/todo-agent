import { useState, type FormEvent } from "react";
import { efforts, priorities } from "../shared/task.ts";
import {
  frequencies,
  inbox,
  repeatLabels,
  type Planner,
  type PlannerTask,
} from "../shared/planner.ts";
import type { Action } from "./planner-client.ts";

export function TaskEditor({
  task,
  data,
  act,
  close,
  open,
}: {
  task: PlannerTask;
  data: Planner;
  act: Action;
  close(): void;
  open(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [child, setChild] = useState("");
  const [scope, setScope] = useState<"one" | "future">("one");
  const children = data.tasks.filter((t) => t.parentId === task.id);
  const [original] = useState(() => ({
    title: task.title,
    notes: task.notes ?? "",
    tags: (task.tags ?? []).join("，"),
    listId: task.listId ?? inbox,
    parentId: task.parentId ?? "",
    dueDate: task.dueDate ?? "",
    dueTime: task.dueTime ?? "",
    reminder: task.reminder ?? "",
    priority: typeof task.priority === "string" ? task.priority : "",
    effort: typeof task.effort === "string" ? task.effort : "",
    repeat: task.repeat ?? "",
    starred: !!task.starred,
  }));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const changes: Record<string, unknown> = {};
    for (const [key, initial] of Object.entries(original)) {
      if (!form.has(key) && key !== "starred") continue;
      const value = key === "starred" ? form.has(key) : String(form.get(key) ?? "").trim();
      if (value === initial) continue;
      changes[key] =
        key === "tags"
          ? String(value)
              .split(/[,，]/u)
              .map((v) => v.trim())
              .filter(Boolean)
          : value === "" && key !== "notes"
            ? null
            : value;
    }
    if (Object.keys(changes).length) {
      setBusy(true);
      const ok = await act("planner/tasks/" + task.id, "PATCH", { changes, scope });
      setBusy(false);
      if (!ok) return;
    }
    close();
  }
  async function addChild(e: FormEvent) {
    e.preventDefault();
    if (!child.trim() || busy) return;
    setBusy(true);
    if (await act("planner/tasks", "POST", { title: child.trim(), parentId: task.id }))
      setChild("");
    setBusy(false);
  }
  return (
    <section className="editor">
      <div className="section-top">
        <h2>任务详情</h2>
        <button onClick={close}>返回清单</button>
      </div>
      <form className="fields" onSubmit={save}>
        <label className="wide">
          任务名称
          <input name="title" required maxLength={200} defaultValue={original.title} />
        </label>
        <label className="wide">
          备注
          <textarea name="notes" rows={3} defaultValue={original.notes} />
        </label>
        <label>
          清单
          <select name="listId" defaultValue={original.listId}>
            {data.lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          标签
          <input name="tags" placeholder="用逗号分隔" defaultValue={original.tags} />
        </label>
        <label>
          截止日期
          <input type="date" name="dueDate" defaultValue={original.dueDate} />
        </label>
        <label>
          截止时间
          <input type="time" name="dueTime" defaultValue={original.dueTime} />
        </label>
        <label className="wide">
          提醒时间 · {data.timeZone}
          <input type="datetime-local" name="reminder" defaultValue={original.reminder} />
        </label>
        {task.repeat && !task.done && (
          <label>
            更改范围
            <select
              aria-label="更改范围"
              value={scope}
              onChange={(e) => setScope(e.target.value as typeof scope)}
            >
              <option value="one">仅本次</option>
              <option value="future">本次及以后</option>
            </select>
          </label>
        )}
        <label>
          重复
          <select
            name="repeat"
            disabled={
              !!children.length ||
              !!task.parentId ||
              task.done ||
              (!!task.repeat && scope === "one")
            }
            defaultValue={original.repeat}
          >
            <option value="">不重复</option>
            {frequencies.map((f) => (
              <option key={f} value={f}>
                {repeatLabels[f]}
              </option>
            ))}
          </select>
        </label>
        <label>
          优先级
          <select name="priority" defaultValue={original.priority}>
            <option value="">未设置</option>
            {priorities.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          工作量
          <select name="effort" defaultValue={original.effort}>
            <option value="">未设置</option>
            {efforts.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          父任务
          <select name="parentId" defaultValue={original.parentId}>
            <option value="">无</option>
            {data.tasks
              .filter((t) => t.id !== task.id && !t.repeat)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </label>
        <label className="check-field">
          <input name="starred" type="checkbox" defaultChecked={original.starred} />
          星标
        </label>
        <div className="wide editor-actions">
          <button className="primary" disabled={busy}>
            保存更改
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={async () => {
              if (
                window.confirm("删除这条任务？子任务将保留。") &&
                (await act("tasks/" + task.id, "DELETE"))
              )
                close();
            }}
          >
            删除任务
          </button>
        </div>
      </form>
      {!task.repeat && (
        <section className="child-editor">
          <h3>子任务</h3>
          {children.map((c) => (
            <button key={c.id} onClick={() => open(c.id)}>
              {c.done ? "✓ " : "○ "}
              {c.title}
            </button>
          ))}
          <form onSubmit={addChild}>
            <input
              aria-label="新子任务"
              placeholder="添加子任务…"
              value={child}
              onChange={(e) => setChild(e.target.value)}
              maxLength={200}
            />
            <button disabled={busy || !child.trim()}>添加</button>
          </form>
        </section>
      )}
    </section>
  );
}
