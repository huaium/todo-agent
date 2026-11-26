import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { inbox, type PlannerTask } from "../shared/planner.ts";
import { api, ApiError } from "./planner-client.ts";

function fields(task: PlannerTask) {
  return {
    title: task.title,
    notes: task.notes ?? "",
    tags: task.tags ?? [],
    listId: task.listId ?? inbox,
    parentId: task.parentId ?? "",
    dueDate: task.dueDate ?? "",
    dueTime: task.dueTime ?? "",
    reminder: task.reminder ?? "",
    priority: typeof task.priority === "string" ? task.priority : "",
    effort: typeof task.effort === "string" ? task.effort : "",
    repeat: task.repeat ?? "",
    starred: !!task.starred,
  };
}
type Draft = ReturnType<typeof fields>;
type Field = keyof Draft;
export const fieldLabels: Record<Field, string> = {
  title: "任务名称",
  notes: "备注",
  tags: "标签",
  listId: "清单",
  parentId: "父任务",
  dueDate: "截止日期",
  dueTime: "截止时间",
  reminder: "提醒",
  priority: "优先级",
  effort: "工作量",
  repeat: "重复",
  starred: "星标",
};
async function versionOf(task: PlannerTask) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(task)),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
function comparable(value: Draft[Field]) {
  if (Array.isArray(value)) return JSON.stringify(value);
  return typeof value === "string" ? value.trim() : value;
}
function changesSince(saved: Draft, draft: Draft) {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(saved) as Field[]) {
    const value = comparable(draft[key]);
    if (value === comparable(saved[key])) continue;
    changes[key] = key === "tags" ? draft.tags : value === "" && key !== "notes" ? null : value;
  }
  if ("dueDate" in changes && saved.reminder && !("reminder" in changes))
    changes.reminder = saved.reminder;
  return changes;
}

export function useTaskAutosave(
  task: PlannerTask,
  scope: "one" | "future",
  changed: () => Promise<void>,
) {
  const [draft, setDraft] = useState(() => fields(task));
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const saved = useRef(draft);
  const current = useRef(draft);
  const baseTask = useRef(task);
  const blocked = useRef(new Set<Field>());
  const [conflicts, setConflicts] = useState<Field[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const writing = useRef<Promise<boolean> | null>(null);
  const awaitingPatch = useRef(false);
  const composing = useRef(false);
  const options = useRef({ scope, changed });
  useLayoutEffect(() => {
    options.current = { scope, changed };
  }, [scope, changed]);

  // Adopt confirmed values while keeping edits made since the request started.
  const reconcile = useCallback((task: PlannerTask, expected: Draft, remote: boolean) => {
    const next = fields(task);
    const merged = { ...current.current };
    for (const key of Object.keys(next) as Field[]) {
      const local = comparable(current.current[key]);
      const previous = comparable(expected[key]);
      const incoming = comparable(next[key]);
      if (local === incoming) blocked.current.delete(key);
      else if (local === previous && !blocked.current.has(key))
        Object.assign(merged, { [key]: next[key] });
      else if (remote && incoming !== previous) blocked.current.add(key);
    }
    saved.current = next;
    baseTask.current = task;
    setConflicts([...blocked.current]);
    current.current = merged;
    setDraft(merged);
  }, []);
  useLayoutEffect(() => {
    if (!awaitingPatch.current) reconcile(task, saved.current, true);
  }, [task, reconcile]);

  const id = task.id;
  const flush = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (writing.current) return writing.current;
    async function drain() {
      while (!composing.current) {
        if (blocked.current.size) return false;
        const sent = current.current;
        if (!sent.title.trim()) {
          setError("请输入任务名称。");
          setState("error");
          return false;
        }
        const changes = changesSince(saved.current, sent);
        if (!Object.keys(changes).length) {
          setState("saved");
          return true;
        }
        setState("saving");
        try {
          awaitingPatch.current = true;
          const task = await api<PlannerTask>("planner/tasks/" + id, "PATCH", {
            changes,
            scope: options.current.scope,
            expectedVersion: await versionOf(baseTask.current),
          });
          reconcile(task, sent, false);
        } catch (e) {
          if (e instanceof ApiError && e.status === 412 && e.data.current) {
            reconcile(e.data.current as PlannerTask, saved.current, true);
            continue;
          }
          if (sent !== current.current) continue;
          setError(
            e instanceof Error && !(e instanceof TypeError) ? e.message : "请检查网络连接后重试。",
          );
          setState("error");
          return false;
        } finally {
          awaitingPatch.current = false;
        }
        await options.current.changed();
      }
      return false;
    }
    writing.current = drain().finally(() => {
      writing.current = null;
    });
    return writing.current;
  }, [id, reconcile]);

  function schedule() {
    window.clearTimeout(timer.current);
    setState("pending");
    if (!composing.current) timer.current = window.setTimeout(flush, 550);
  }
  function edit(patch: Partial<Draft>) {
    current.current = { ...current.current, ...patch };
    setDraft(current.current);
    schedule();
  }
  function discard() {
    current.current = saved.current;
    setDraft(saved.current);
    setState("saved");
  }
  function resolveConflict(key: Field, useRemote: boolean) {
    blocked.current.delete(key);
    setConflicts([...blocked.current]);
    edit(useRemote ? { [key]: saved.current[key] } : {});
  }
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (state === "idle" || state === "saved") return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    function onHide() {
      if (document.hidden && state !== "error") void flush();
    }
    window.addEventListener("beforeunload", warn);
    window.addEventListener("online", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("online", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [state, flush]);
  return {
    draft,
    state,
    error,
    conflicts,
    remote: saved.current,
    resolveConflict,
    edit,
    flush,
    discard,
    startComposition() {
      composing.current = true;
      window.clearTimeout(timer.current);
    },
    endComposition() {
      composing.current = false;
      schedule();
    },
  };
}
