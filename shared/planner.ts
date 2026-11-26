import type { Task } from "./task.ts";

export const inbox = "inbox";
export const frequencies = ["daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof frequencies)[number];
export const repeatLabels: Record<Frequency, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};
export interface PlannerTask extends Task {
  listId?: string;
  notes?: string;
  tags?: string[];
  starred?: boolean;
  dueDate?: string | null;
  dueTime?: string | null;
  reminder?: string | null;
  parentId?: string | null;
  repeat?: Frequency | null;
  seriesId?: string;
  occurrenceDate?: string;
  successorId?: string;
  snoozeUntil?: string;
  notifiedAt?: string;
}
export interface PersonalList {
  id: string;
  name: string;
}
export interface BinItem {
  id: string;
  title: string;
  listId: string;
  deletedAt: number;
  expiresAt: number;
}
export interface Planner {
  tasks: PlannerTask[];
  lists: PersonalList[];
  timeZone: string | null;
}
export interface PlannerSync {
  revision: string;
  planner: Planner;
  bin: BinItem[] | null;
}
export function localMinute(date: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return (
    values.year + "-" + values.month + "-" + values.day + "T" + values.hour + ":" + values.minute
  );
}
export function offsetDate(date: string, days: number) {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function dayDistance(start: string, end: string) {
  return Math.round((Date.parse(end + "T00:00:00Z") - Date.parse(start + "T00:00:00Z")) / 86400000);
}
export function nextDate(anchor: string, frequency: Frequency, after: string) {
  if (anchor > after) return anchor;
  if (frequency === "daily" || frequency === "weekly") {
    const step = frequency === "daily" ? 1 : 7;
    return offsetDate(anchor, (Math.floor(dayDistance(anchor, after) / step) + 1) * step);
  }
  const origin = new Date(anchor + "T00:00:00Z");
  const end = new Date(after + "T00:00:00Z");
  const step = frequency === "monthly" ? 1 : 12;
  const months =
    (end.getUTCFullYear() - origin.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    origin.getUTCMonth();
  for (let month = Math.floor(months / step) * step; ; month += step) {
    const last = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth() + month + 1, 0));
    last.setUTCDate(Math.min(origin.getUTCDate(), last.getUTCDate()));
    const date = last.toISOString().slice(0, 10);
    if (date > after) return date;
  }
}
export function pendingReminder(task: PlannerTask) {
  return task.done ? null : (task.snoozeUntil ?? task.reminder);
}
