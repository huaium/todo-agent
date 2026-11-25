import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { PlannerError, type TaskDetails } from "./task-details.ts";
import {
  dayDistance,
  frequencies,
  inbox,
  localMinute,
  nextDate,
  offsetDate,
  pendingReminder,
  type Planner,
  type PlannerTask,
} from "../shared/planner.ts";

const row = z.looseObject({ id: z.string(), title: z.string(), done: z.boolean() });
const rows = z.array(row);
const documentSchema = z.object({
  version: z.literal(1),
  lists: z.array(z.object({ id: z.string(), name: z.string() })),
  timeZone: z.string().nullable(),
  tasks: rows,
  series: z.record(
    z.string(),
    z.object({ anchor: z.string(), frequency: z.enum(frequencies), template: row }),
  ),
});
type Database = z.infer<typeof documentSchema> & { tasks: PlannerTask[] };
type Changes = Partial<Pick<PlannerTask, "title" | "done">> & TaskDetails;
export interface TaskStore {
  readonly filename: string;
  list(): PlannerTask[];
  snapshot(): Planner;
  initializeZone(zone: string): void;
  create(title: string, details?: TaskDetails): PlannerTask;
  update(id: string, changes: Changes, scope?: "one" | "future"): PlannerTask | undefined;
  remove(id: string): boolean;
  editList(id: string | null, name: string | null): string;
  reschedule(ids: string[], dueDate: string): void;
  remind(id: string, expected: string, action: "claim" | "snooze"): boolean;
}
function fail(message: string): never {
  throw new PlannerError(message);
}
function shiftedReminder(reminder: string | null | undefined, days: number) {
  return reminder ? offsetDate(reminder.slice(0, 10), days) + reminder.slice(10) : reminder;
}
export function createJsonTaskStore(filename: string, now = () => new Date()): TaskStore {
  const initial = (): Database => ({
    version: 1,
    tasks: [],
    lists: [{ id: inbox, name: "收件箱" }],
    timeZone: null,
    series: {},
  });
  function save(db: Database) {
    mkdirSync(dirname(filename), { recursive: true });
    writeFileSync(filename + ".tmp", JSON.stringify(db, null, 2) + "\n");
    renameSync(filename + ".tmp", filename);
  }
  function read(): Database {
    if (!existsSync(filename)) return initial();
    const data: unknown = JSON.parse(readFileSync(filename, "utf8"));
    if (!Array.isArray(data)) return documentSchema.parse(data);
    const db = initial();
    db.tasks = rows.parse(data);
    save(db);
    return db;
  }
  function transact<T>(fn: (db: Database) => T): T {
    const db = read();
    const result = fn(db);
    save(db);
    return result;
  }
  function zone(db: Database) {
    return db.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  function change(db: Database, t: PlannerTask, delta: Changes, scope: "one" | "future") {
    const before = { ...t };
    Object.assign(t, delta);
    if (delta.tags) t.tags = [...new Set(delta.tags)];
    const parent = db.tasks.find((p) => p.id === t.parentId);
    if (t.parentId && !parent) fail("找不到父任务。");
    if (parent && (parent.repeat || t.repeat)) fail("重复任务不能包含子任务。");
    if (delta.parentId && parent) {
      if (typeof parent.listId === "string") t.listId = parent.listId;
      else delete t.listId;
    }
    if (t.listId && !db.lists.some((l) => l.id === t.listId)) fail("清单不存在。");
    if (parent && (parent.listId ?? inbox) !== (t.listId ?? inbox))
      fail("请先解除父任务关系再移动清单。");
    if (delta.parentId) {
      const seen = new Set([t.id]);
      let ancestor = parent;
      while (ancestor) {
        if (seen.has(ancestor.id)) fail("任务之间不能循环嵌套。");
        seen.add(ancestor.id);
        ancestor = db.tasks.find((p) => p.id === ancestor!.parentId);
      }
    }
    if (before.listId !== t.listId) {
      const moving = new Set([t.id]);
      for (const id of moving)
        for (const child of db.tasks.filter((p) => p.parentId === id)) {
          child.listId = t.listId;
          moving.add(child.id);
        }
    }
    if (delta.dueDate === null) t.dueTime = null;
    if (t.dueTime && !t.dueDate) fail("请先设置截止日期。");
    if (
      delta.dueDate !== undefined &&
      before.dueDate !== t.dueDate &&
      delta.reminder === undefined &&
      before.reminder
    ) {
      t.reminder =
        t.dueDate && before.dueDate
          ? shiftedReminder(before.reminder, dayDistance(before.dueDate, t.dueDate))
          : null;
    }
    if (
      before.reminder !== t.reminder ||
      delta.done !== undefined ||
      before.dueDate !== t.dueDate ||
      before.dueTime !== t.dueTime
    ) {
      delete t.notifiedAt;
      delete t.snoozeUntil;
    }
    const hasSchedule = t.dueDate || (before.seriesId && scope === "one" && t.occurrenceDate);
    if (t.repeat && (!hasSchedule || t.parentId || db.tasks.some((p) => p.parentId === t.id)))
      fail("重复任务需要截止日期，且必须是独立任务。");
    if (t.repeat && !before.seriesId) {
      t.seriesId = randomUUID();
      t.occurrenceDate = t.dueDate!;
      db.series[t.seriesId] = { anchor: t.dueDate!, frequency: t.repeat, template: { ...t } };
    }
    let series = t.seriesId ? db.series[t.seriesId] : undefined;
    if (before.seriesId && series && scope === "future") {
      if (before.successorId) fail("请从当前重复任务修改后续安排。");
      if (delta.repeat === null) {
        delete db.series[before.seriesId];
        delete t.seriesId;
        series = undefined;
      } else {
        const template: PlannerTask = series.template;
        const baseDate = delta.dueDate ?? t.occurrenceDate ?? t.dueDate!;
        // Keep the reminder offset relative to the occurrence being edited.
        template.reminder = shiftedReminder(
          template.reminder,
          dayDistance(template.dueDate!, baseDate),
        );
        template.dueDate = baseDate;
        Object.assign(template, delta);
        if (delta.reminder && t.dueDate)
          template.reminder = shiftedReminder(delta.reminder, dayDistance(t.dueDate, baseDate));
        if (delta.repeat) series.frequency = delta.repeat;
        if (delta.dueDate || delta.repeat) {
          series.anchor = t.dueDate!;
          t.occurrenceDate = t.dueDate!;
        }
      }
    }
    if (before.done && delta.done === false && t.successorId) {
      delete t.seriesId;
      delete t.repeat;
      delete t.occurrenceDate;
      delete t.successorId;
    }
    if (delta.done && !before.done && series && !t.successorId) {
      const today = localMinute(now(), zone(db)).slice(0, 10);
      const after = [today, t.occurrenceDate ?? t.dueDate!].sort().at(-1)!;
      const date = nextDate(series.anchor, series.frequency, after);
      const template: PlannerTask = series.template;
      const next: PlannerTask = {
        ...template,
        id: randomUUID(),
        done: false,
        seriesId: t.seriesId,
        repeat: series.frequency,
        dueDate: date,
        occurrenceDate: date,
        reminder: shiftedReminder(template.reminder, dayDistance(template.dueDate!, date)),
      };
      delete next.successorId;
      delete next.snoozeUntil;
      delete next.notifiedAt;
      t.successorId = next.id;
      db.tasks.push(next);
    }
    return t;
  }
  return {
    filename,
    list: () => read().tasks,
    snapshot() {
      const { tasks, lists, timeZone } = read();
      return { tasks, lists, timeZone };
    },
    initializeZone(value) {
      if (read().timeZone) return;
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        fail("无效的时区。");
      }
      transact((db) => {
        db.timeZone = value;
      });
    },
    create(title, details = {}) {
      return transact((db) => {
        const t = { id: randomUUID(), title, done: false };
        db.tasks.push(t);
        return change(db, t, details, "future");
      });
    },
    update(id, delta, scope = "one") {
      return transact((db) => {
        const task = db.tasks.find((p) => p.id === id);
        return task && change(db, task, delta, scope);
      });
    },
    remove(id) {
      return transact((db) => {
        const i = db.tasks.findIndex((p) => p.id === id);
        if (i < 0) return false;
        const [removed] = db.tasks.splice(i, 1);
        for (const p of db.tasks) if (p.parentId === id) delete p.parentId;
        if (typeof removed.seriesId === "string" && !removed.done)
          delete db.series[removed.seriesId];
        return true;
      });
    },
    editList(id, name) {
      return transact((db) => {
        if (id === inbox) fail("收件箱是系统清单。");
        if (name && db.lists.some((l) => l.name === name && l.id !== id)) fail("清单名称已存在。");
        if (!id) {
          if (!name) fail("请输入清单名称。");
          const list = { id: randomUUID(), name };
          db.lists.push(list);
          return list.id;
        }
        const list = db.lists.find((l) => l.id === id);
        if (!list) fail("清单不存在。");
        if (name) list.name = name;
        else {
          db.lists = db.lists.filter((l) => l.id !== id);
          for (const task of [...db.tasks, ...Object.values(db.series).map((s) => s.template)])
            if (task.listId === id) delete task.listId;
        }
        return id;
      });
    },
    reschedule(ids, date) {
      transact((db) => {
        for (const id of new Set(ids)) {
          const t = db.tasks.find((p) => p.id === id);
          if (!t || t.done) fail("预览中的任务已变化，请重新预览。");
          change(db, t, { dueDate: date }, "one");
        }
      });
    },
    remind(id, expected, action) {
      return transact((db) => {
        const t: PlannerTask | undefined = db.tasks.find((p) => p.id === id);
        const current = localMinute(now(), zone(db));
        if (!t || pendingReminder(t) !== expected || expected > current) return false;
        if (action === "snooze") {
          t.snoozeUntil = localMinute(new Date(now().valueOf() + 600000), zone(db));
          delete t.notifiedAt;
        } else {
          if (t.notifiedAt === expected) return false;
          t.notifiedAt = expected;
        }
        return true;
      });
    },
  };
}
