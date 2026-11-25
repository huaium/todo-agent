import { useMemo, useState } from "react";
import type { PlannerTask } from "../shared/planner.ts";
import { efforts, priorities } from "../shared/task.ts";

export const taskMethods = ["manual", "due", "priority", "effort", "title"] as const;
export type SortMethod = (typeof taskMethods)[number];
export interface SortChoice {
  method: SortMethod;
  reverse: boolean;
}
export const sortLabels = {
  manual: "手动排序",
  due: "截止时间",
  priority: "优先级",
  effort: "工作量",
  title: "标题",
};
export const directionLabels = {
  due: ["最早优先", "最晚优先"],
  priority: ["高优先", "低优先"],
  effort: ["小优先", "大优先"],
  title: ["标题正序", "标题倒序"],
};

const titles = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function rank(values: readonly string[], value: unknown) {
  const index = typeof value === "string" ? values.indexOf(value) : -1;
  return index < 0 ? null : index;
}

function compare<T extends string | number>(
  a: T | null | undefined,
  b: T | null | undefined,
  sign: number,
) {
  if (a == null || b == null) return Number(a == null) - Number(b == null);
  return a < b ? -sign : a > b ? sign : 0;
}

export function sortTasks(tasks: PlannerTask[], { method, reverse }: SortChoice) {
  if (method === "manual") return tasks;
  const sign = reverse ? -1 : 1;
  return tasks.toSorted((a, b) => {
    switch (method) {
      case "due":
        return (
          compare(a.dueDate, b.dueDate, sign) ||
          (a.dueDate && b.dueDate ? compare(a.dueTime, b.dueTime, sign) : 0)
        );
      case "priority":
        return compare(rank(priorities, a.priority), rank(priorities, b.priority), -sign);
      case "effort":
        return compare(rank(efforts, a.effort), rank(efforts, b.effort), sign);
      case "title":
        return titles.compare(a.title, b.title) * sign;
    }
  });
}

const preferenceKey = (view: string) => "planner-sort:" + view;
function readSort(view: string): SortChoice {
  const dateView = view === "today" || view === "upcoming";
  let method: SortMethod = dateView ? "due" : "manual";
  try {
    const saved = localStorage.getItem(preferenceKey(view));
    if (saved) {
      const match = taskMethods.find(
        (key) => saved === key || (key !== "manual" && saved === "-" + key),
      );
      if (match) return { method: match, reverse: saved.startsWith("-") };
    }
    if (dateView && localStorage.getItem("planner-date-order") === "manual") method = "manual";
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
  }
  return { method, reverse: false };
}

export function useViewSort(view: string) {
  const [choices, setChoices] = useState<Record<string, SortChoice>>({});
  const choice = useMemo(() => choices[view] ?? readSort(view), [choices, view]);
  function select(next: SortChoice) {
    setChoices((previous) => ({ ...previous, [view]: next }));
    try {
      localStorage.setItem(preferenceKey(view), (next.reverse ? "-" : "") + next.method);
    } catch (error) {
      if (
        !(
          error instanceof DOMException &&
          ["SecurityError", "QuotaExceededError"].includes(error.name)
        )
      )
        throw error;
    }
  }
  return [choice, select] as const;
}
