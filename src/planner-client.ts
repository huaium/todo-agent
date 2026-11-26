import { useCallback, useEffect, useRef, useState } from "react";
import { publishTaskRows } from "./task-row-motion.ts";
import {
  localMinute,
  pendingReminder,
  type BinItem,
  type Planner,
  type PlannerSync,
} from "../shared/planner.ts";

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, data: Record<string, unknown>) {
    super(String(data.error || "请求失败。"));
    this.status = status;
    this.data = data;
  }
}
export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api/" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}
export function usePlanner(showBin: boolean) {
  const [data, setData] = useState<Planner>({ tasks: [], lists: [], timeZone: null });
  const [bin, setBin] = useState<BinItem[] | null>(null);
  const [ready, setReady] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const lastResults = useRef<{ showBin: boolean; revision: string } | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(new Date());
  const serial = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const opened = useRef(new Date());
  const alerts = useRef(new Map<string, { at: string; notification: Notification }>());
  const load = useCallback(
    async (mode: "refresh" | "saved" | "reorder", force = false) => {
      const ticket = ++serial.current;
      try {
        const previous = lastResults.current;
        const path = "planner/sync?bin=" + Number(showBin);
        const after =
          !force && previous?.showBin === showBin
            ? "&after=" + encodeURIComponent(previous.revision)
            : "";
        let snapshot = await api<PlannerSync | undefined>(path + after);
        if (!snapshot || ticket !== serial.current) return;
        if (!snapshot.planner.timeZone) {
          await api("planner/timezone", "POST", {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          });
          snapshot = await api<PlannerSync>(path);
        }
        if (ticket === serial.current) {
          const { revision, planner: next, bin: deleted } = snapshot;
          const refreshChanged =
            mode === "refresh" && previous?.showBin === showBin && previous.revision !== revision;
          lastResults.current = { showBin, revision };
          const publish = () => {
            if (refreshChanged) setRefreshRevision((value) => value + 1);
            setBin(deleted);
            setData(next);
            setReady(true);
          };
          if (mode === "saved") publishTaskRows(next.tasks, publish);
          else publish();
          return next;
        }
      } catch (e) {
        if (ticket === serial.current) setError(e instanceof Error ? e.message : "无法读取任务。");
      }
    },
    [showBin],
  );
  const refresh = useCallback(async () => {
    await load("refresh");
  }, [load]);
  useEffect(() => {
    function tick() {
      const next = new Date();
      setNow((previous) =>
        Math.floor(previous.getTime() / 60000) === Math.floor(next.getTime() / 60000)
          ? previous
          : next,
      );
    }
    const timer = window.setInterval(tick, 15000);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);
  useEffect(() => {
    void refresh();
    const bus = new BroadcastChannel("xiaoming-planner");
    channel.current = bus;
    bus.onmessage = refresh;
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      serial.current++;
      bus.close();
      channel.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const changed = async (animateRows = true) => {
    channel.current?.postMessage("changed");
    await load(animateRows ? "saved" : "reorder");
  };
  const act: Action = async (path, method, body, report = setError) => {
    try {
      setError("");
      await api(path, method, body);
      await changed(path !== "planner/tasks/order");
      return true;
    } catch (e) {
      report(e instanceof Error ? e.message : "无法保存更改。");
      return false;
    }
  };
  const clock = localMinute(now, data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const due = data.tasks.filter((t) => {
    const at = pendingReminder(t);
    return at && at <= clock;
  });
  useEffect(() => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const openedAt = localMinute(
      opened.current,
      data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    for (const [id, alert] of alerts.current) {
      const task = data.tasks.find((t) => t.id === id);
      if (!task || pendingReminder(task) !== alert.at) {
        alert.notification.close();
        alerts.current.delete(id);
      }
    }
    for (const task of data.tasks) {
      const at = pendingReminder(task);
      if (!at || at < openedAt || at > clock || task.notifiedAt === at) continue;
      void api<{ applied: boolean }>("planner/reminders/" + task.id, "POST", {
        at,
        action: "claim",
      })
        .then((result) => {
          if (result.applied) {
            const notification = new Notification(task.title, {
              body: "小明 · 任务提醒",
              tag: task.id,
            });
            alerts.current.set(task.id, { at, notification });
            notification.onclose = () => {
              if (alerts.current.get(task.id)?.notification === notification)
                alerts.current.delete(task.id);
            };
            channel.current?.postMessage("changed");
            void refresh();
          }
        })
        .catch((e) => setError(e instanceof Error ? e.message : "无法送达浏览器通知。"));
    }
  }, [clock, data, refresh]);
  return {
    data,
    bin,
    ready,
    refreshRevision,
    error,
    setError,
    act,
    changed,
    refresh,
    readForEditor: () => load("refresh", true),
    today: clock.slice(0, 10),
    due,
  };
}
export type Action = (
  path: string,
  method: string,
  body?: unknown,
  report?: (message: string) => void,
) => Promise<boolean>;
