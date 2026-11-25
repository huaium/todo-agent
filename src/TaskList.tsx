import { useEffect, useState } from "react";
import { efforts, priorities, type Task } from "../shared/task.ts";

interface TaskListProps {
  revision: number;
  refresh(): void;
}

function TaskRow({ task, parent }: { task: Task; parent?: Task }) {
  const details = [
    parent && `子任务 · ${parent.title}`,
    typeof task.dueDate === "string" && `${task.dueDate} 到期`,
    priorities.some((p) => p === task.priority) && `${task.priority}优先级`,
    efforts.some((e) => e === task.effort) && `工作量${task.effort}`,
  ].filter(Boolean);
  return (
    <li className={task.done ? "task done" : "task"}>
      <span className="task-status" aria-hidden="true">
        {task.done ? "✓" : ""}
      </span>
      <div>
        <span className="task-title">{task.title}</span>
        {details.length > 0 && <small>{details.join(" · ")}</small>}
      </div>
    </li>
  );
}

export function TaskList({ revision, refresh }: TaskListProps) {
  const [tasks, setTasks] = useState<Task[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/tasks", { signal: controller.signal });
        if (!response.ok) throw new Error("暂时无法读取清单，请刷新重试。");
        const current: Task[] = await response.json();
        if (!controller.signal.aborted) {
          setTasks(current);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取清单失败。");
      }
    }
    void load();
    return () => controller.abort();
  }, [revision]);
  const byId = new Map(tasks?.map((task) => [task.id, task]));
  return (
    <aside className="task-panel" aria-label="任务清单">
      <div className="panel-heading">
        <h2>任务清单</h2>
        <button onClick={refresh}>刷新</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {tasks === undefined && !error && <p role="status">正在读取…</p>}
      {tasks?.length === 0 && <p>清单是空的。告诉小明你要做什么。</p>}
      {[false, true].map((done) => {
        const group = tasks?.filter((task) => task.done === done);
        if (!group?.length) return null;
        return (
          <section className="task-group" key={String(done)}>
            <h3>
              {done ? "已完成" : "待办"} <span>{group.length}</span>
            </h3>
            <ul>
              {group.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  parent={typeof task.parentId === "string" ? byId.get(task.parentId) : undefined}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </aside>
  );
}
