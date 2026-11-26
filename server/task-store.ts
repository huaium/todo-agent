import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { binRetentionMs, readPlanner, readTasks, transaction, type Series } from "./database.ts";
import { PlannerError, TaskEditConflict, type TaskDetails } from "./task-details.ts";
import {
  dayDistance,
  inbox,
  localMinute,
  nextDate,
  offsetDate,
  pendingReminder,
  type Planner,
  type PlannerSync,
  type BinItem,
  type PlannerTask,
} from "../shared/planner.ts";

type Changes = Partial<Pick<PlannerTask, "title" | "done">> & TaskDetails;
export interface TaskQuery {
  query?: string;
  id?: string;
  listId?: string;
  parentId?: string;
  dueDate?: string;
  done?: boolean;
  starred?: boolean;
  priority?: string;
  effort?: string;
  visibleIds?: string[];
}
export interface TaskStore {
  search(query: TaskQuery, offset: number, limit: number): PlannerTask[];
  taskContext(id: string): Planner;
  findLists(query: string, offset: number, limit: number): Planner["lists"];
  timeZone(): string;
  list(): PlannerTask[];
  listByCreation(): PlannerTask[];
  snapshot(): Planner;
  sync(previous: string | undefined, includeBin: boolean): PlannerSync | undefined;
  initializeZone(zone: string): void;
  create(title: string, details?: TaskDetails): PlannerTask;
  update(
    id: string,
    changes: Changes,
    scope?: "one" | "future",
    expectedVersion?: string,
  ): PlannerTask | undefined;
  remove(id: string): boolean;
  removeCompleted(ids: string[]): void;
  bin(): BinItem[];
  restore(id: string, deletedAt: number): boolean;
  deleteBinItems(entries: Pick<BinItem, "id" | "deletedAt">[]): number;
  purgeExpired(): void;
  reorder(previous: string[], ordered: string[]): boolean;
  moveRelative(id: string, anchorId: string, side: "before" | "after"): PlannerTask;
  editList(id: string | null, name: string | null): string;
  reschedule(ids: string[], dueDate: string): void;
  remind(id: string, expected: string, action: "claim" | "snooze"): boolean;
}
function fail(message: string): never {
  throw new PlannerError(message);
}
function shiftedReminder(reminder: PlannerTask["reminder"], fromDate: string, toDate: string) {
  if (!reminder) return reminder;
  const days = dayDistance(fromDate, toDate);
  return offsetDate(reminder.slice(0, 10), days) + reminder.slice(10);
}
function updateSeriesTemplate(series: Series, task: PlannerTask, delta: Changes) {
  const template = series.template;
  const baseDate = delta.dueDate ?? task.occurrenceDate ?? task.dueDate!;
  // Keep the reminder offset relative to the occurrence being edited.
  template.reminder = shiftedReminder(template.reminder, template.dueDate!, baseDate);
  template.dueDate = baseDate;
  Object.assign(template, delta);
  if (delta.reminder && task.dueDate)
    template.reminder = shiftedReminder(delta.reminder, task.dueDate, baseDate);
  if (delta.repeat) series.frequency = delta.repeat;
  if (delta.dueDate || delta.repeat) {
    series.anchor = task.dueDate!;
    task.occurrenceDate = task.dueDate!;
  }
}
export function createTaskStore(db: DatabaseSync, now = () => new Date()): TaskStore {
  const session = randomUUID();
  const revisionQuery = db.prepare("SELECT revision FROM planner_revision WHERE id=1");
  const byId = db.prepare("SELECT payload FROM tasks WHERE id=?");
  const purge = db.prepare("DELETE FROM task_bin WHERE deleted_at<=?");
  const purgeExpired = () => {
    purge.run(now().getTime() - binRetentionMs);
  };
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
  function moveToBin(task: PlannerTask) {
    const series =
      task.seriesId && !task.done
        ? db.prepare("SELECT payload FROM series WHERE id=?").get(task.seriesId)
        : undefined;
    db.prepare("INSERT INTO task_bin(id,deleted_at,payload,series) VALUES(?,?,?,?)").run(
      task.id,
      now().getTime(),
      JSON.stringify(task),
      series?.payload ?? null,
    );
    db.prepare("DELETE FROM tasks WHERE id=?").run(task.id);
    for (const child of matching(byParent, task.id)) {
      delete child.parentId;
      save(child);
    }
    if (task.seriesId && !task.done) db.prepare("DELETE FROM series WHERE id=?").run(task.seriesId);
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
      before.dueDate &&
      t.dueDate &&
      before.dueDate !== t.dueDate &&
      delta.reminder === undefined &&
      before.reminder
    ) {
      t.reminder = shiftedReminder(before.reminder, before.dueDate, t.dueDate);
    }
    if (before.reminder !== t.reminder || before.done !== t.done) {
      delete t.notifiedAt;
      delete t.snoozeUntil;
    }
    updateRecurrence(t, before, delta, scope);
    save(t);
    return t;
  }
  function updateRecurrence(
    t: PlannerTask,
    before: PlannerTask,
    delta: Changes,
    scope: "one" | "future",
  ) {
    if (
      before.seriesId &&
      scope === "one" &&
      delta.repeat !== undefined &&
      (delta.repeat !== before.repeat || delta.repeat === null)
    )
      fail("修改或取消重复规则时，请选择本次及后续任务。");
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
        updateSeriesTemplate(series, t, delta);
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
        reminder: shiftedReminder(template.reminder, template.dueDate!, date),
      };
      delete next.successorId;
      delete next.snoozeUntil;
      delete next.notifiedAt;
      t.successorId = next.id;
      save(next);
    }
  }
  function writeOrder(previous: string[], ordered: string[]) {
    const slots = db
      .prepare(
        "SELECT id, position FROM tasks WHERE id IN (SELECT value FROM json_each(?)) ORDER BY position",
      )
      .all(JSON.stringify(previous));
    if (slots.length !== previous.length || slots.some((row, i) => row.id !== previous[i]))
      return false;
    const assign = db.prepare("UPDATE tasks SET position=? WHERE id=?");
    // Vacate the changed slots before assigning their final positions.
    for (const [i, row] of slots.entries())
      if (previous[i] !== ordered[i]) assign.run(-Number(row.position), previous[i]);
    for (const [i, row] of slots.entries())
      if (previous[i] !== ordered[i]) assign.run(row.position, ordered[i]);
    return true;
  }
  return {
    timeZone: zone,
    taskContext(id) {
      const tasks: PlannerTask[] = [];
      const seen = new Set<string>();
      let task = get(id);
      while (task && !seen.has(task.id)) {
        tasks.push(task);
        seen.add(task.id);
        task = task.parentId ? get(task.parentId) : undefined;
      }
      const row = db.prepare("SELECT id,name FROM lists WHERE id=?").get(tasks[0]?.listId ?? inbox);
      return {
        tasks,
        timeZone: zone(),
        lists: row ? [{ id: String(row.id), name: String(row.name) }] : [],
      };
    },
    findLists: (query, offset, limit) =>
      db
        .prepare(
          "SELECT id,name FROM lists WHERE instr(lower(name),lower(?))>0 ORDER BY position LIMIT ? OFFSET ?",
        )
        .all(query, limit, offset)
        .map((row) => ({ id: String(row.id), name: String(row.name) })),
    search(query, offset, limit) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      const columns = {
        id: "id",
        parentId: "json_extract(payload,'$.parentId')",
        listId: "coalesce(json_extract(payload,'$.listId'),'inbox')",
        dueDate: "json_extract(payload,'$.dueDate')",
        done: "json_extract(payload,'$.done')",
        starred: "coalesce(json_extract(payload,'$.starred'),0)",
        priority: "json_extract(payload,'$.priority')",
        effort: "json_extract(payload,'$.effort')",
      };
      for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
        const value = query[key];
        if (value === undefined) continue;
        conditions.push(columns[key] + "=?");
        params.push(typeof value === "boolean" ? Number(value) : value);
      }
      if (query.query) {
        conditions.push(`(instr(lower(json_extract(payload,'$.title')),lower(?))>0
          OR instr(lower(json_extract(payload,'$.notes')),lower(?))>0
          OR EXISTS(SELECT 1 FROM json_each(payload,'$.tags') WHERE instr(lower(value),lower(?))>0))`);
        params.push(query.query, query.query, query.query);
      }
      if (query.visibleIds) {
        conditions.push("id IN (SELECT value FROM json_each(?))");
        params.push(JSON.stringify(query.visibleIds));
      }
      const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
      return db
        .prepare("SELECT payload FROM tasks" + where + " ORDER BY position LIMIT ? OFFSET ?")
        .all(...params, limit, offset)
        .map((row) => JSON.parse(String(row.payload)));
    },
    list: () => readTasks(db),
    listByCreation: () =>
      db
        .prepare("SELECT payload FROM task_creation JOIN tasks USING(id) ORDER BY seq")
        .all()
        .map((row) => JSON.parse(String(row.payload))),
    snapshot: () => readPlanner(db),
    sync(previous, includeBin) {
      if (includeBin) purgeExpired();
      return transaction(
        db,
        () => {
          const revision = `${session}/${revisionQuery.get()!.revision}/${Number(includeBin)}`;
          if (previous === revision) return;
          return { revision, planner: readPlanner(db), bin: includeBin ? this.bin() : null };
        },
        "DEFERRED",
      );
    },
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
    update(id, delta, scope = "one", expectedVersion) {
      return transaction(db, () => {
        const task = get(id);
        if (
          task &&
          expectedVersion &&
          createHash("sha256").update(JSON.stringify(task)).digest("hex") !== expectedVersion
        )
          throw new TaskEditConflict(task);
        return task && change(task, delta, scope);
      });
    },
    remove(id) {
      return transaction(db, () => {
        const removed = get(id);
        if (!removed) return false;
        moveToBin(removed);
        return true;
      });
    },
    removeCompleted(ids) {
      transaction(db, () => {
        const completed = this.search({ visibleIds: ids, done: true }, 0, ids.length);
        for (const task of completed) moveToBin(task);
      });
    },
    purgeExpired,
    bin() {
      return db
        .prepare(`SELECT id, deleted_at, json_extract(payload,'$.title') AS title,
        json_extract(payload,'$.listId') AS list_id FROM task_bin
        WHERE deleted_at>? ORDER BY deleted_at DESC,id`)
        .all(now().getTime() - binRetentionMs)
        .map((row) => ({
          id: String(row.id),
          title: String(row.title),
          listId: String(row.list_id ?? inbox),
          deletedAt: Number(row.deleted_at),
          expiresAt: Number(row.deleted_at) + binRetentionMs,
        }));
    },
    deleteBinItems(entries) {
      return transaction(db, () => {
        const remove = db.prepare("DELETE FROM task_bin WHERE id=? AND deleted_at=?");
        let deleted = 0;
        for (const { id, deletedAt } of entries)
          deleted += Number(remove.run(id, deletedAt).changes);
        return deleted;
      });
    },
    restore(id, deletedAt) {
      return transaction(db, () => {
        purgeExpired();
        const row = db
          .prepare("SELECT payload,series FROM task_bin WHERE id=? AND deleted_at=?")
          .get(id, deletedAt);
        if (!row) return false;
        const task: PlannerTask = JSON.parse(String(row.payload));
        const listExists = (listId: string) =>
          db.prepare("SELECT 1 FROM lists WHERE id=?").get(listId);
        if (task.listId && !listExists(task.listId)) delete task.listId;
        if (task.parentId) {
          const parent = get(task.parentId);
          if (!parent || parent.repeat) delete task.parentId;
          else task.listId = parent.listId;
        }
        if (task.seriesId && row.series !== null) {
          const series: Series = JSON.parse(String(row.series));
          if (series.template.listId && !listExists(series.template.listId))
            delete series.template.listId;
          putSeries.run(task.seriesId, JSON.stringify(series));
        }
        save(task);
        db.prepare("DELETE FROM task_bin WHERE id=?").run(id);
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
    reorder(previous, ordered) {
      const ids = new Set(previous);
      if (
        ids.size !== previous.length ||
        ordered.length !== ids.size ||
        new Set(ordered).size !== ids.size ||
        ordered.some((id) => !ids.has(id))
      )
        fail("排序必须包含同一组任务，且不能重复。");
      return transaction(db, () => writeOrder(previous, ordered));
    },
    moveRelative(id, anchorId, side) {
      return transaction(db, () => {
        if (id === anchorId) fail("请选择两条不同的任务。");
        const task = get(id),
          anchor = get(anchorId);
        if (!task || !anchor) return fail("移动的任务或参照任务已不存在。");
        if (!anchor.parentId && task.done !== anchor.done)
          fail("两条任务分属待办和已完成，无法在这两个分组之间手动排序。");
        if ((task.parentId ?? null) !== (anchor.parentId ?? null)) {
          if ((task.listId ?? inbox) !== (anchor.listId ?? inbox))
            fail("调整层级涉及跨清单移动，请先指定目标清单。");
          change(task, { parentId: anchor.parentId ?? null }, "one");
        }
        const previous = db
          .prepare("SELECT id FROM tasks ORDER BY position")
          .all()
          .map((row) => String(row.id));
        const ordered = previous.filter((key) => key !== id);
        ordered.splice(ordered.indexOf(anchorId) + Number(side === "after"), 0, id);
        if (!writeOrder(previous, ordered)) fail("任务顺序已变化。");
        return task;
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
