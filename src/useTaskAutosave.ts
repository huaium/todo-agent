import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { inbox, type PlannerTask } from "../shared/planner.ts";
import { api } from "./planner-client.ts";

function fields(task: PlannerTask) {
  return {
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
  };
}
type Draft = ReturnType<typeof fields>;
type Field = keyof Draft;
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
function tags(value: string) {
  return value
    .split(/[,，]/u)
    .map((tag) => tag.trim())
    .filter(Boolean);
}
function normalized(key: Field, value: Draft[Field]) {
  if (typeof value !== "string") return value;
  return key === "tags" ? [...new Set(tags(value))].join("，") : value.trim();
}
function changesSince(saved: Draft, draft: Draft) {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(saved) as Field[]) {
    const value = normalized(key, draft[key]);
    if (value === normalized(key, saved[key])) continue;
    changes[key] =
      key === "tags" ? tags(String(value)) : value === "" && key !== "notes" ? null : value;
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
  const timer = useRef<number | undefined>(undefined);
  const writing = useRef<Promise<boolean> | null>(null);
  const awaitingPatch = useRef(false);
  const composing = useRef(false);
  const options = useRef({ scope, changed });
  useLayoutEffect(() => {
    options.current = { scope, changed };
  }, [scope, changed]);

  // Adopt confirmed values while keeping edits made since the request started.
  const reconcile = useCallback((task: PlannerTask, expected: Draft) => {
    const next = fields(task);
    const merged = { ...current.current };
    for (const key of Object.keys(next) as Field[]) {
      if (
        normalized(key, current.current[key]) === normalized(key, expected[key]) &&
        normalized(key, current.current[key]) !== normalized(key, next[key])
      )
        Object.assign(merged, { [key]: next[key] });
    }
    saved.current = next;
    current.current = merged;
    setDraft(merged);
  }, []);
  useLayoutEffect(() => {
    if (!awaitingPatch.current) reconcile(task, saved.current);
  }, [task, reconcile]);

  const id = task.id;
  const flush = useCallback((): Promise<boolean> => {
    window.clearTimeout(timer.current);
    if (writing.current) return writing.current;
    async function drain() {
      while (!composing.current) {
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
          });
          reconcile(task, sent);
        } catch (e) {
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
