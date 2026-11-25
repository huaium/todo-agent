import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { detailsSchema, PlannerError } from "./task-details.ts";
import type { TaskStore } from "./task-store.ts";
import { createTaskSchema } from "./tasks.ts";
import { plannerChanges } from "../shared/task-details.ts";
export { plannerChanges };
import type { BulkPreview } from "../shared/chat.ts";

const listName = z.strictObject({ name: z.string().trim().min(1).max(80) });
const binEntry = z.strictObject({ deletedAt: z.number().int() });
const binEntryMissing = { error: "这条回收站记录已失效，请刷新后重试。" };
export function bulkPreviews(store: TaskStore) {
  const pending = new Map<
    string,
    { ids: string[]; date: string; snapshot: string; expires: number }
  >();
  function records(ids: string[]) {
    const tasks = new Map(store.list().map((t) => [t.id, t]));
    return ids.map((id) => {
      const t = tasks.get(id);
      if (!t || t.done) throw new PlannerError("任务已变化，请重新预览。");
      return t;
    });
  }
  return {
    discard(token: string) {
      pending.delete(token);
    },
    preview(ids: string[], date: string): BulkPreview {
      ids = [...new Set(ids)];
      const tasks = records(ids);
      const token = randomUUID();
      for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
      pending.set(token, {
        ids,
        date,
        snapshot: JSON.stringify(tasks),
        expires: Date.now() + 600000,
      });
      return { token, date, titles: tasks.map((t) => t.title) };
    },
    confirm(token: string) {
      const p = pending.get(token);
      pending.delete(token);
      if (!p || p.expires < Date.now() || JSON.stringify(records(p.ids)) !== p.snapshot)
        throw new PlannerError("预览已失效，请重新预览。");
      store.reschedule(p.ids, p.date);
    },
  };
}
export function plannerRouter(store: TaskStore, bulk: ReturnType<typeof bulkPreviews>) {
  const router = Router();
  router.get("/", (_req, res) => res.json(store.snapshot()));
  router.get("/bin", (_req, res) => res.set("Cache-Control", "no-store").json(store.bin()));
  router.post("/bin/:id/restore", (req, res) => {
    const { deletedAt } = binEntry.parse(req.body);
    if (!store.restore(req.params.id, deletedAt)) return res.status(404).json(binEntryMissing);
    res.sendStatus(204);
  });
  router.delete("/bin/:id", (req, res) => {
    const { deletedAt } = binEntry.parse(req.body);
    if (!store.deleteBinItem(req.params.id, deletedAt))
      return res.status(404).json(binEntryMissing);
    res.sendStatus(204);
  });
  router.post("/timezone", (req, res) => {
    store.initializeZone(z.string().min(1).parse(req.body.timeZone));
    res.json(store.snapshot());
  });
  router.post("/lists", (req, res) =>
    res.status(201).json({ id: store.editList(null, listName.parse(req.body).name) }),
  );
  router.patch("/lists/:id", (req, res) =>
    res.json({ id: store.editList(req.params.id, listName.parse(req.body).name) }),
  );
  router.delete("/lists/:id", (req, res) => {
    store.editList(req.params.id, null);
    res.sendStatus(204);
  });
  router.post("/tasks", (req, res) => {
    const { title, ...details } = detailsSchema
      .safeExtend({ title: createTaskSchema.shape.title })
      .parse(req.body);
    res.status(201).json(store.create(title, details));
  });
  router.post("/tasks/order", (req, res) => {
    const ids = z.array(z.string().min(1)).min(2);
    const { previous, ordered } = z.strictObject({ previous: ids, ordered: ids }).parse(req.body);
    if (!store.reorder(previous, ordered))
      return res.status(409).json({ error: "任务顺序已变化，请按最新顺序重试。" });
    res.sendStatus(204);
  });
  router.patch("/tasks/:id", (req, res) => {
    const { changes, scope } = z
      .strictObject({ changes: plannerChanges, scope: z.enum(["one", "future"]).optional() })
      .parse(req.body);
    const task = store.update(req.params.id, changes, scope);
    if (!task) return res.status(404).json({ error: "找不到这条任务。" });
    res.json(task);
  });
  router.post("/reminders/:id", (req, res) => {
    const { at, action } = z
      .strictObject({ at: z.string(), action: z.enum(["claim", "snooze"]) })
      .parse(req.body);
    res.json({ applied: store.remind(req.params.id, at, action) });
  });
  router.post("/reschedule/:token", (req, res) => {
    bulk.confirm(req.params.token);
    res.sendStatus(204);
  });
  return router;
}
