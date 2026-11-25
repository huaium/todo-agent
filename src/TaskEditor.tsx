import { useState, type FormEvent } from "react";
import { Button, Checkbox, Input, Label, Surface, TextArea, TextField } from "@heroui/react";
import { ChoiceField, options } from "./PlannerControls.tsx";
import { PlannerDate, PlannerTime } from "./ScheduleFields.tsx";
import { efforts, priorities } from "../shared/task.ts";
import {
  frequencies,
  inbox,
  repeatLabels,
  type Planner,
  type PlannerTask,
} from "../shared/planner.ts";
import type { Action } from "./planner-client.ts";

export function TaskEditor({
  task,
  data,
  act,
  close,
  open,
  requestDelete,
}: {
  task: PlannerTask;
  data: Planner;
  act: Action;
  close(): void;
  open(id: string): void;
  requestDelete(id: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [child, setChild] = useState("");
  const [childError, setChildError] = useState("");
  const [scope, setScope] = useState<"one" | "future">("one");
  const children = data.tasks.filter((t) => t.parentId === task.id);
  const [original] = useState(() => ({
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
  }));
  const [draft, setDraft] = useState(original);
  function set<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) {
    setDraft((old) => ({ ...old, [key]: value }));
  }
  const zone = data.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const repeatLocked =
    !!children.length || !!task.parentId || task.done || (!!task.repeat && scope === "one");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setSaveError("");
    const changes: Record<string, unknown> = {};
    for (const key of Object.keys(original) as (keyof typeof original)[]) {
      if (key === "repeat" && repeatLocked) continue;
      const initial = original[key];
      const edited = draft[key];
      const value = typeof edited === "string" ? edited.trim() : edited;
      if (value === initial) continue;
      changes[key] =
        key === "tags"
          ? String(value)
              .split(/[,，]/u)
              .map((v) => v.trim())
              .filter(Boolean)
          : value === "" && key !== "notes"
            ? null
            : value;
    }
    if (!draft.title.trim()) {
      setSaveError("请输入任务名称。");
      return;
    }
    if ("dueDate" in changes && task.reminder && !("reminder" in changes))
      changes.reminder = task.reminder;
    if (Object.keys(changes).length) {
      setBusy(true);
      const ok = await act("planner/tasks/" + task.id, "PATCH", { changes, scope }, setSaveError);
      setBusy(false);
      if (!ok) return;
    }
    close();
  }
  async function addChild(e: FormEvent) {
    e.preventDefault();
    if (!child.trim() || busy) return;
    setBusy(true);
    setChildError("");
    if (
      await act("planner/tasks", "POST", { title: child.trim(), parentId: task.id }, setChildError)
    )
      setChild("");
    setBusy(false);
  }
  return (
    <section className="editor">
      <div className="section-top">
        <h2>任务详情</h2>
        <Button variant="tertiary" onPress={close}>
          返回清单
        </Button>
      </div>
      <form onSubmit={save}>
        <Surface className="fields">
          <h3 className="wide">任务信息</h3>
          <TextField
            className="wide"
            isRequired
            value={draft.title}
            onChange={(v) => set("title", v)}
          >
            <Label>任务名称</Label>
            <Input maxLength={200} />
          </TextField>
          <TextField className="wide" value={draft.notes} onChange={(v) => set("notes", v)}>
            <Label>备注</Label>
            <TextArea rows={3} />
          </TextField>
          <ChoiceField
            label="清单"
            value={draft.listId}
            choices={data.lists.map((l) => ({ value: l.id, label: l.name }))}
            onChange={(v) => set("listId", v)}
          />
          <TextField value={draft.tags} onChange={(v) => set("tags", v)}>
            <Label>标签</Label>
            <Input placeholder="用逗号分隔" />
          </TextField>
          <ChoiceField
            label="优先级"
            value={draft.priority}
            choices={[{ value: "", label: "未设置" }, ...options(priorities)]}
            onChange={(v) => set("priority", v)}
          />
          <ChoiceField
            label="工作量"
            value={draft.effort}
            choices={[{ value: "", label: "未设置" }, ...options(efforts)]}
            onChange={(v) => set("effort", v)}
          />
          <ChoiceField
            label="父任务"
            value={draft.parentId}
            choices={[
              { value: "", label: "无" },
              ...data.tasks
                .filter((t) => t.id !== task.id && !t.repeat)
                .map((t) => ({ value: t.id, label: t.title })),
            ]}
            onChange={(v) => set("parentId", v)}
          />
          <Checkbox isSelected={draft.starred} onChange={(v) => set("starred", v)}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              星标
            </Checkbox.Content>
          </Checkbox>
        </Surface>
        <Surface className="fields schedule">
          <h3 className="wide">日期与提醒</h3>
          <PlannerDate
            label="截止日期"
            zone={zone}
            value={draft.dueDate}
            onChange={(dueDate) =>
              setDraft((old) => ({ ...old, dueDate, dueTime: dueDate ? old.dueTime : "" }))
            }
          />
          <PlannerTime
            label="截止时间"
            value={draft.dueTime}
            disabled={!draft.dueDate}
            onChange={(v) => set("dueTime", v)}
          />
          <div className="wide">
            <PlannerDate
              withTime
              label={"提醒时间 · " + zone}
              zone={zone}
              value={draft.reminder}
              onChange={(v) => set("reminder", v)}
            />
          </div>
          {task.repeat && !task.done && (
            <ChoiceField
              label="更改范围"
              value={scope}
              choices={[
                { value: "one", label: "仅本次" },
                { value: "future", label: "本次及以后" },
              ]}
              onChange={(v) => setScope(v === "future" ? "future" : "one")}
            />
          )}
          <ChoiceField
            label="重复"
            value={draft.repeat}
            disabled={repeatLocked}
            choices={[
              { value: "", label: "不重复" },
              ...frequencies.map((f) => ({ value: f, label: repeatLabels[f] })),
            ]}
            onChange={(v) => set("repeat", v)}
          />
        </Surface>
        {saveError && <p role="alert">{saveError}</p>}
        <div className="wide editor-actions">
          <Button type="submit" isPending={busy}>
            保存更改
          </Button>
          <Button variant="danger-soft" isDisabled={busy} onPress={() => requestDelete(task.id)}>
            删除任务
          </Button>
        </div>
      </form>
      {!task.repeat && (
        <Surface className="child-editor">
          <h3>子任务</h3>
          {children.map((c) => (
            <Button variant="ghost" key={c.id} onPress={() => open(c.id)}>
              {c.done ? "✓ " : "○ "}
              {c.title}
            </Button>
          ))}
          <form onSubmit={addChild}>
            <Input
              aria-label="新子任务"
              placeholder="添加子任务…"
              value={child}
              onChange={(e) => setChild(e.target.value)}
              maxLength={200}
            />
            <Button type="submit" variant="secondary" isDisabled={busy || !child.trim()}>
              添加
            </Button>
          </form>
          {childError && <p role="alert">{childError}</p>}
        </Surface>
      )}
    </section>
  );
}
