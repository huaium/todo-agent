import { useCallback, useEffect, useRef, useState } from "react";
import { localMinute, pendingReminder, type BinItem, type Planner } from "../shared/planner.ts";

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api/" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}
export function usePlanner(showBin: boolean) {
  const [data, setData] = useState<Planner>({ tasks: [], lists: [], timeZone: null });
  const [bin, setBin] = useState<BinItem[] | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(new Date());
  const serial = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const opened = useRef(new Date());
  const alerts = useRef(new Map<string, { at: string; notification: Notification }>());
  const refresh = useCallback(async () => {
    const ticket = ++serial.current;
    try {
      let next = await api<Planner>("planner");
      if (!next.timeZone)
        next = await api<Planner>("planner/timezone", "POST", {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
      const deleted = showBin ? await api<BinItem[]>("planner/bin") : null;
      if (ticket === serial.current) {
        setBin(deleted);
        setData(next);
        setReady(true);
        setNow(new Date());
      }
    } catch (e) {
      if (ticket === serial.current) setError(e instanceof Error ? e.message : "无法读取任务。");
    }
  }, [showBin]);
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
  const changed = async () => {
    channel.current?.postMessage("changed");
    await refresh();
  };
  const act: Action = async (path, method, body, report = setError) => {
    try {
      setError("");
      await api(path, method, body);
      await changed();
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
    error,
    setError,
    act,
    changed,
    refresh,
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
