import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { inbox, pendingReminder } from "../shared/planner.ts";
import { priorities } from "../shared/task.ts";
import { TaskList } from "./TaskList.tsx";
import { TaskEditor } from "./TaskEditor.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { usePlanner } from "./planner-client.ts";

const views = [
  ["today", "今天", ""],
  ["upcoming", "即将到期", "◷"],
  ["starred", "星标", "☆"],
  ["all", "全部", "☷"],
  ["done", "已完成", "✓"],
] as const;

function FilterField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
}) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <select
        aria-label={`按${label}筛选`}
        data-active={value !== "" || undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">全部</option>
        {children}
      </select>
    </label>
  );
}

export default function App() {
  const { data, ready, error, setError, act, changed, today, due } = usePlanner();
  const [view, setView] = useState("today");
  const [pane, setPane] = useState("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [priority, setPriority] = useState("");
  const [listFilter, setListFilter] = useState("");
  const [status, setStatus] = useState("");
  const [filters, setFilters] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const capture = useRef<HTMLInputElement>(null);
  const [listEdit, setListEdit] = useState<string | null>(null);
  const [listName, setListName] = useState("");
  const [notifications, setNotifications] = useState(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [remindersOpen, setRemindersOpen] = useState(true);
  const personal = view.startsWith("list:") ? view.slice(5) : null;
  const label =
    views.find((v) => v[0] === view)?.[1] ??
    data.lists.find((l) => l.id === personal)?.name ??
    "收件箱";
  const selectedTask = data.tasks.find((t) => t.id === selected);
  const tags = [...new Set(data.tasks.flatMap((t) => t.tags ?? []))].sort();
  function inView(t: (typeof data.tasks)[number], v: string) {
    if (v === "today") return !t.done && !!t.dueDate && t.dueDate <= today;
    if (v === "upcoming") return !t.done && !!t.dueDate && t.dueDate > today;
    if (v === "starred") return !t.done && t.starred;
    if (v === "done") return t.done;
    return v === "all" || v === "list:" + (t.listId ?? inbox);
  }
  const items = data.tasks.filter(
    (t) =>
      inView(t, view) &&
      (!tag || t.tags?.includes(tag)) &&
      (!priority || t.priority === priority) &&
      (!listFilter || (t.listId ?? inbox) === listFilter) &&
      (!status || t.done === (status === "done")) &&
      (!query.trim() ||
        [
          t.title,
          t.notes,
          ...(t.tags ?? []),
          data.lists.find((l) => l.id === (t.listId ?? inbox))?.name,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())),
  );
  if (view === "today" || view === "upcoming")
    items.sort(
      (a, b) =>
        (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
        (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99"),
    );
  function navigate(v: string, nextTag = "") {
    setView(v);
    setTag(nextTag);
    setPriority("");
    setListFilter("");
    setStatus("");
    setQuery("");
    setSelected(null);
    setPane("list");
  }
  function open(id: string) {
    setSelected(id);
    setPane("editor");
  }
  function back() {
    setSelected(null);
    setPane("list");
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    const ok = await act("planner/tasks", "POST", {
      title: draft.trim(),
      ...(personal && { listId: personal }),
      ...(view === "today" && { dueDate: today }),
    });
    setSaving(false);
    if (ok) setDraft("");
    capture.current?.focus();
  }
  async function saveList(e: FormEvent) {
    e.preventDefault();
    if (!listName.trim() || listEdit === null) return;
    const isNew = listEdit === "new";
    if (
      await act(isNew ? "planner/lists" : "planner/lists/" + listEdit, isNew ? "POST" : "PATCH", {
        name: listName.trim(),
      })
    ) {
      setListEdit(null);
      setListName("");
    }
  }
  async function notify() {
    if (!("Notification" in window)) return;
    try {
      const permission = await Notification.requestPermission();
      setNotifications(permission);
      await changed();
    } catch {
      setError("浏览器未允许通知。");
    }
  }
  const filtered = !!(tag || priority || status || listFilter);
  return (
    <div className="planner-app" data-pane={pane}>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      <nav className="rail" aria-label="工作区导航">
        <div className="brand">
          <img src="/logo.png" alt="" />
          <b>TokeNow</b>
          <button className="mobile-only" onClick={() => setPane("list")}>
            返回
          </button>
        </div>
        <div className="nav-views">
          {views.map(([id, name, icon]) => (
            <button
              key={id}
              aria-current={view === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <i aria-hidden="true">
                {id === "today" ? <span className="calendar-day">{today.slice(-2)}</span> : icon}
              </i>
              {name}
              <small>{data.tasks.filter((t) => inView(t, id)).length || ""}</small>
            </button>
          ))}
        </div>
        <div className="rail-heading">
          我的清单
          <button
            title="新建清单"
            aria-label="新建清单"
            onClick={() => {
              setListEdit("new");
              setListName("");
            }}
          >
            ＋
          </button>
        </div>
        <div className="nav-views">
          {data.lists.map((l) => (
            <button
              key={l.id}
              aria-current={personal === l.id ? "page" : undefined}
              onClick={() => navigate("list:" + l.id)}
            >
              <i aria-hidden="true">{l.id === inbox ? "▱" : "≡"}</i>
              {l.name}
              <small>
                {data.tasks.filter((t) => (t.listId ?? inbox) === l.id && !t.done).length || ""}
              </small>
            </button>
          ))}
        </div>
        {listEdit !== null && (
          <form className="list-editor" onSubmit={saveList}>
            <input
              aria-label="清单名称"
              placeholder="清单名称"
              maxLength={80}
              autoFocus
              value={listName}
              onChange={(e) => setListName(e.target.value)}
            />
            <button>保存</button>
            <button type="button" onClick={() => setListEdit(null)}>
              取消
            </button>
          </form>
        )}
        {tags.length > 0 && (
          <>
            <div className="rail-heading">标签</div>
            <div className="tag-cloud">
              {tags.map((t) => (
                <button
                  key={t}
                  className={tag === t ? "chosen" : ""}
                  onClick={() => navigate("all", t)}
                >
                  # {t}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="rail-foot">
          <button onClick={notify} disabled={notifications !== "default"}>
            {notifications === "granted"
              ? "✓ 浏览器通知已开启"
              : notifications === "denied"
                ? "浏览器已阻止通知"
                : notifications === "unsupported"
                  ? "使用应用内提醒"
                  : "开启浏览器通知"}
          </button>
          <small>{data.timeZone}</small>
        </div>
      </nav>
      <main className="planner-main">
        <div className="toolbar">
          <button className="mobile-only" aria-label="打开导航" onClick={() => setPane("nav")}>
            ☰
          </button>
          <label className="search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              aria-label="搜索任务"
              placeholder="搜索任务、清单或标签"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!query && !personal) setView("all");
              }}
            />
          </label>
          <button
            aria-expanded={filters}
            className={filtered ? "selected-filter" : ""}
            onClick={() => setFilters(!filters)}
          >
            筛选{filtered ? " •" : ""}
          </button>
          <button className="mobile-only" onClick={() => setPane("chat")}>
            小明
          </button>
        </div>
        {filters && (
          <div className="filters" role="group" aria-label="任务筛选">
            <FilterField label="清单" value={listFilter} onChange={setListFilter}>
              {data.lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </FilterField>
            <FilterField label="标签" value={tag} onChange={setTag}>
              {tags.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </FilterField>
            <FilterField label="优先级" value={priority} onChange={setPriority}>
              {priorities.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </FilterField>
            <FilterField label="完成状态" value={status} onChange={setStatus}>
              <option value="open">待办</option>
              <option value="done">已完成</option>
            </FilterField>
          </div>
        )}
        <div className="list-scroll" hidden={!!selectedTask}>
          {due.length > 0 && (
            <section className="reminders">
              <button
                onClick={() => setRemindersOpen(!remindersOpen)}
                aria-expanded={remindersOpen}
              >
                到点提醒 · {due.length} {remindersOpen ? "▾" : "▸"}
              </button>
              {remindersOpen &&
                due.map((t) => (
                  <div key={t.id}>
                    <span>
                      {t.title}
                      <small>{pendingReminder(t)?.replace("T", " ")}</small>
                    </span>
                    <button
                      onClick={() =>
                        act("planner/tasks/" + t.id, "PATCH", { changes: { done: true } })
                      }
                    >
                      完成
                    </button>
                    <button
                      onClick={() =>
                        act("planner/reminders/" + t.id, "POST", {
                          at: pendingReminder(t),
                          action: "snooze",
                        })
                      }
                    >
                      稍后 10 分钟
                    </button>
                  </div>
                ))}
            </section>
          )}
          <div className="view-head">
            <div>
              <h1>{label}</h1>
              <p>
                {new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeZone: "UTC" }).format(
                  new Date(today + "T12:00:00Z"),
                )}
              </p>
            </div>
            {personal && personal !== inbox && (
              <details className="row-menu">
                <summary aria-label="清单操作">···</summary>
                <div>
                  <button
                    onClick={() => {
                      setListEdit(personal);
                      setListName(label);
                      setPane("nav");
                    }}
                  >
                    重命名清单
                  </button>
                  <button
                    onClick={async () => {
                      if (
                        confirm("删除清单并将任务移入收件箱？") &&
                        (await act("planner/lists/" + personal, "DELETE"))
                      )
                        navigate("list:" + inbox);
                    }}
                  >
                    删除清单
                  </button>
                </div>
              </details>
            )}
          </div>
          <form className="capture" onSubmit={create}>
            <button disabled={saving || !draft.trim()} aria-label="添加任务">
              ＋
            </button>
            <input
              aria-label="快速添加任务"
              ref={capture}
              maxLength={200}
              placeholder="添加任务…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              readOnly={saving}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                )
                  e.preventDefault();
              }}
            />
          </form>
          {ready ? (
            <TaskList items={items} data={data} view={view} today={today} open={open} act={act} />
          ) : (
            <p role="status">正在读取清单…</p>
          )}
        </div>
        {selectedTask && (
          <TaskEditor
            key={selectedTask.id}
            task={selectedTask}
            data={data}
            act={act}
            close={back}
            open={open}
          />
        )}
      </main>
      <ChatPanel
        context={{
          view: label,
          visibleIds: items.map((t) => t.id),
          selectedId: selectedTask?.id ?? null,
        }}
        changed={changed}
        close={() => setPane(selectedTask ? "editor" : "list")}
      />
    </div>
  );
}
