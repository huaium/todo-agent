import { useMemo, useState } from "react";
import type { BinItem, PlannerTask } from "../shared/planner.ts";
import { efforts, priorities } from "../shared/task.ts";

export const taskMethods = ["manual", "due", "priority", "effort", "title"] as const;
export const binMethods = ["deleted", "title"] as const;
type TaskMethod = (typeof taskMethods)[number];
type BinMethod = (typeof binMethods)[number];
export type SortMethod = TaskMethod | BinMethod;
export interface SortChoice<M extends SortMethod = TaskMethod> {
  method: M;
  reverse: boolean;
}
export const sortLabels = {
  manual: "手动排序",
  due: "截止时间",
  priority: "优先级",
  effort: "工作量",
  title: "标题",
  deleted: "删除时间",
};
export const directionLabels = {
  manual: [],
  due: ["最早优先", "最晚优先"],
  priority: ["高优先", "低优先"],
  effort: ["小优先", "大优先"],
  title: ["标题正序", "标题倒序"],
  deleted: ["最近删除优先", "最早删除优先"],
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

export function sortBin(items: BinItem[], { method, reverse }: SortChoice<BinMethod>) {
  const sign = reverse ? -1 : 1;
  return items.toSorted(
    (a, b) =>
      sign * (method === "deleted" ? b.deletedAt - a.deletedAt : titles.compare(a.title, b.title)),
  );
}

const preferenceKey = (view: string) => "planner-sort:" + view;
function readSort<M extends SortMethod>(
  view: string,
  methods: readonly M[],
  defaultMethod: M,
): SortChoice<M> {
  let method = defaultMethod;
  try {
    const saved = localStorage.getItem(preferenceKey(view));
    if (saved) {
      const match = methods.find(
        (key) => saved === key || (key !== "manual" && saved === "-" + key),
      );
      if (match) return { method: match, reverse: saved.startsWith("-") };
    }
    if (defaultMethod === "due" && localStorage.getItem("planner-date-order") === "manual")
      method = methods.find((key) => key === "manual") ?? defaultMethod;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
  }
  return { method, reverse: false };
}

export function useViewSort<M extends SortMethod>(
  view: string,
  methods: readonly M[],
  defaultMethod: M,
) {
  const [choices, setChoices] = useState<Record<string, SortChoice<M>>>({});
  const choice = useMemo(
    () => choices[view] ?? readSort(view, methods, defaultMethod),
    [choices, view, methods, defaultMethod],
  );
  function select(next: SortChoice<M>) {
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
