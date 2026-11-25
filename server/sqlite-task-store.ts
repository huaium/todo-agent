import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { readPlanner, readTasks, transaction, type Series } from "./database.ts";
import { PlannerError, type TaskDetails } from "./task-details.ts";
import {
  dayDistance,
  inbox,
  localMinute,
  nextDate,
  offsetDate,
  pendingReminder,
  type Planner,
  type PlannerTask,
} from "../shared/planner.ts";

type Changes = Partial<Pick<PlannerTask, "title" | "done">> & TaskDetails;
export interface TaskStore {
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
export function createTaskStore(db: DatabaseSync, now = () => new Date()): TaskStore {
  const byId = db.prepare("SELECT payload FROM tasks WHERE id=?");
  const byParent = db.prepare(
    "SELECT payload FROM tasks WHERE json_extract(payload,'$.parentId')=? ORDER BY position",
  );
  const byList = db.prepare("SELECT payload FROM tasks WHERE json_extract(payload,'$.listId')=?");
  const put = db.prepare(
    "INSERT INTO tasks(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
  );
  const putSeries = db.prepare(
    "INSERT INTO series(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
  );
  function get(id: string): PlannerTask | undefined {
    const r = byId.get(id);
    return r && JSON.parse(String(r.payload));
  }
  function matching(statement: StatementSync, id: string): PlannerTask[] {
    return statement.all(id).map((r) => JSON.parse(String(r.payload)));
  }
  function save(task: PlannerTask) {
    put.run(task.id, JSON.stringify(task));
  }
  function zone() {
    return String(
      db.prepare("SELECT time_zone FROM settings WHERE id=1").get()!.time_zone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  }
  function change(t: PlannerTask, delta: Changes, scope: "one" | "future") {
    const before = { ...t };
    Object.assign(t, delta);
    if (delta.tags) t.tags = [...new Set(delta.tags)];
    const parent = t.parentId ? get(t.parentId) : undefined;
    if (t.parentId && !parent) fail("找不到父任务。");
    if (parent && (parent.repeat || t.repeat)) fail("重复任务不能包含子任务。");
    if (delta.parentId && parent) {
      if (typeof parent.listId === "string") t.listId = parent.listId;
      else delete t.listId;
    }
    if (t.listId && !db.prepare("SELECT 1 FROM lists WHERE id=?").get(t.listId))
      fail("清单不存在。");
    if (parent && (parent.listId ?? inbox) !== (t.listId ?? inbox))
      fail("请先解除父任务关系再移动清单。");
    if (delta.parentId) {
      const seen = new Set([t.id]);
      let ancestor = parent;
      while (ancestor) {
        if (seen.has(ancestor.id)) fail("任务之间不能循环嵌套。");
        seen.add(ancestor.id);
        ancestor = ancestor.parentId ? get(ancestor.parentId) : undefined;
      }
    }
    if (before.listId !== t.listId) {
      const moving = new Set([t.id]);
      for (const id of moving)
        for (const child of matching(byParent, id)) {
          child.listId = t.listId;
          save(child);
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
    if (t.repeat && (!hasSchedule || t.parentId || byParent.get(t.id)))
      fail("重复任务需要截止日期，且必须是独立任务。");
    if (t.repeat && !before.seriesId) {
      t.seriesId = randomUUID();
      t.occurrenceDate = t.dueDate!;
      putSeries.run(
        t.seriesId,
        JSON.stringify({ anchor: t.dueDate!, frequency: t.repeat, template: { ...t } }),
      );
    }
    const stored =
      t.seriesId && db.prepare("SELECT payload FROM series WHERE id=?").get(t.seriesId);
    let series: Series | undefined = stored ? JSON.parse(String(stored.payload)) : undefined;
    if (before.seriesId && series && scope === "future") {
      if (before.successorId) fail("请从当前重复任务修改后续安排。");
      if (delta.repeat === null) {
        db.prepare("DELETE FROM series WHERE id=?").run(before.seriesId);
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
        putSeries.run(before.seriesId, JSON.stringify(series));
      }
    }
    if (before.done && delta.done === false && t.successorId) {
      delete t.seriesId;
      delete t.repeat;
      delete t.occurrenceDate;
      delete t.successorId;
    }
    if (delta.done && !before.done && series && !t.successorId) {
      const today = localMinute(now(), zone()).slice(0, 10);
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
      save(next);
    }
    save(t);
    return t;
  }
  return {
    list: () => readTasks(db),
    snapshot: () => readPlanner(db),
    initializeZone(value) {
      if (db.prepare("SELECT time_zone FROM settings WHERE id=1").get()!.time_zone) return;
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        fail("无效的时区。");
      }
      db.prepare("UPDATE settings SET time_zone=? WHERE id=1 AND time_zone IS NULL").run(value);
    },
    create(title, details = {}) {
      return transaction(db, () => {
        const t = { id: randomUUID(), title, done: false };
        return change(t, details, "future");
      });
    },
    update(id, delta, scope = "one") {
      return transaction(db, () => {
        const task = get(id);
        return task && change(task, delta, scope);
      });
    },
    remove(id) {
      return transaction(db, () => {
        const removed = get(id);
        if (!removed) return false;
        db.prepare("DELETE FROM tasks WHERE id=?").run(id);
        for (const p of matching(byParent, id)) {
          delete p.parentId;
          save(p);
        }
        if (typeof removed.seriesId === "string" && !removed.done)
          db.prepare("DELETE FROM series WHERE id=?").run(removed.seriesId);
        return true;
      });
    },
    editList(id, name) {
      return transaction(db, () => {
        if (id === inbox) fail("收件箱是系统清单。");
        if (name && db.prepare("SELECT 1 FROM lists WHERE name=? AND id IS NOT ?").get(name, id))
          fail("清单名称已存在。");
        if (!id) {
          if (!name) fail("请输入清单名称。");
          const list = { id: randomUUID(), name };
          db.prepare("INSERT INTO lists(id,name) VALUES(?,?)").run(list.id, list.name);
          return list.id;
        }
        const list = db.prepare("SELECT 1 FROM lists WHERE id=?").get(id);
        if (!list) fail("清单不存在。");
        if (name) db.prepare("UPDATE lists SET name=? WHERE id=?").run(name, id);
        else {
          db.prepare("DELETE FROM lists WHERE id=?").run(id);
          for (const task of matching(byList, id)) {
            delete task.listId;
            save(task);
          }
          db.prepare(
            "UPDATE series SET payload=json_remove(payload,'$.template.listId') WHERE json_extract(payload,'$.template.listId')=?",
          ).run(id);
        }
        return id;
      });
    },
    reschedule(ids, date) {
      transaction(db, () => {
        for (const id of new Set(ids)) {
          const t = get(id);
          if (!t || t.done) fail("预览中的任务已变化，请重新预览。");
          change(t, { dueDate: date }, "one");
        }
      });
    },
    remind(id, expected, action) {
      return transaction(db, () => {
        const t = get(id);
        const current = localMinute(now(), zone());
        if (!t || pendingReminder(t) !== expected || expected > current) return false;
        if (action === "snooze") {
          t.snoozeUntil = localMinute(new Date(now().valueOf() + 600000), zone());
          delete t.notifiedAt;
        } else {
          if (t.notifiedAt === expected) return false;
          t.notifiedAt = expected;
        }
        save(t);
        return true;
      });
    },
  };
}
