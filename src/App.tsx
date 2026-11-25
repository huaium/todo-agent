import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, Dropdown, Input } from "@heroui/react";
import { ChoiceField, ConfirmAction, options } from "./PlannerControls.tsx";
import { inbox, pendingReminder } from "../shared/planner.ts";
import { priorities } from "../shared/task.ts";
import { TaskList } from "./TaskList.tsx";
import { TaskBin } from "./TaskBin.tsx";
import { TaskEditor } from "./TaskEditor.tsx";
import { ChatPanel } from "./ChatPanel.tsx";
import { ThemeControl } from "./ThemeControl.tsx";
import { usePlanner } from "./planner-client.ts";
import { cancelTaskRowAnimations, publishTaskRows, revealTaskResults } from "./task-row-motion.ts";
import { SortMenu } from "./SortMenu.tsx";
import { sortTasks, taskMethods, useViewSort, type SortChoice } from "./task-sort.ts";

const views = [
  ["today", "今天", ""],
  ["upcoming", "即将到期", "◷"],
  ["starred", "星标", "☆"],
  ["all", "全部", "☷"],
  ["done", "已完成", "✓"],
] as const;

export default function App() {
  const [activeView, setView] = useState("today");
  const [query, setQuery] = useState("");
  const view =
    query.trim() && activeView !== "bin" && !activeView.startsWith("list:") ? "all" : activeView;
  const showBin = view === "bin";
  const { data, bin, ready, refreshRevision, error, setError, act, changed, refresh, today, due } =
    usePlanner(showBin);
  const [sort, selectSort] = useViewSort(
    activeView,
    taskMethods,
    activeView === "today" || activeView === "upcoming" ? "due" : "manual",
  );
  const orderedTasks = useMemo(() => sortTasks(data.tasks, sort), [data.tasks, sort]);
  function changeSort(choice: SortChoice) {
    publishTaskRows(data.tasks, () => selectSort(choice));
  }
  const [pane, setPane] = useState("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [tag, setTag] = useState("");
  const [priority, setPriority] = useState("");
  const [listFilter, setListFilter] = useState("");
  const [status, setStatus] = useState("");
  const [filters, setFilters] = useState(false);
  const resultsReady = showBin ? bin !== null : ready;
  useLayoutEffect(() => {
    cancelTaskRowAnimations();
    if (resultsReady && !selected) return revealTaskResults();
  }, [
    view,
    pane,
    selected,
    query,
    tag,
    priority,
    listFilter,
    status,
    resultsReady,
    refreshRevision,
  ]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const [listError, setListError] = useState("");
  const [savingList, setSavingList] = useState(false);
  const capture = useRef<HTMLInputElement>(null);
  const [listEdit, setListEdit] = useState<string | null>(null);
  const [listName, setListName] = useState("");
  const [deleteList, setDeleteList] = useState(false);
  const [deleteTaskId, setDeleteTaskId] = useState<string | null>(null);
  const listMenu = useRef<HTMLButtonElement>(null);
  const [notifications, setNotifications] = useState(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [remindersOpen, setRemindersOpen] = useState(true);
  const personal = view.startsWith("list:") ? view.slice(5) : null;
  const label =
    (showBin ? "回收站" : undefined) ??
    views.find((v) => v[0] === view)?.[1] ??
    data.lists.find((l) => l.id === personal)?.name ??
    "收件箱";
  const selectedTask = data.tasks.find((t) => t.id === selected);
  const deleteTask = data.tasks.find((t) => t.id === deleteTaskId);
  const tags = [...new Set(data.tasks.flatMap((t) => t.tags ?? []))].sort();
  function inView(t: (typeof data.tasks)[number], v: string) {
    if (v === "today") return !t.done && !!t.dueDate && t.dueDate <= today;
    if (v === "upcoming") return !t.done && !!t.dueDate && t.dueDate > today;
    if (v === "starred") return !t.done && t.starred;
    if (v === "done") return t.done;
    return v === "all" || v === "list:" + (t.listId ?? inbox);
  }
  const items = orderedTasks.filter(
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
    requestAnimationFrame(() => capture.current?.focus());
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    if (!draft.trim() || saving) return;
    setSaving(true);
    setCaptureError("");
    const ok = await act(
      "planner/tasks",
      "POST",
      {
        title: draft.trim(),
        ...(personal && { listId: personal }),
        ...(view === "today" && { dueDate: today }),
      },
      setCaptureError,
    );
    setSaving(false);
    if (ok) setDraft("");
    capture.current?.focus();
  }
  async function saveList(e: FormEvent) {
    e.preventDefault();
    if (!listName.trim() || listEdit === null || savingList) return;
    setSavingList(true);
    setListError("");
    const isNew = listEdit === "new";
    if (
      await act(
        isNew ? "planner/lists" : "planner/lists/" + listEdit,
        isNew ? "POST" : "PATCH",
        {
          name: listName.trim(),
        },
        setListError,
      )
    ) {
      setListEdit(null);
      setListName("");
    }
    setSavingList(false);
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
          <Button variant="ghost" size="sm" onPress={() => setError("")}>
            关闭
          </Button>
        </div>
      )}
      <nav className="rail" aria-label="工作区导航">
        <div className="brand">
          <img src="/logo.png" alt="" />
          <b>TokeNow</b>
          <Button variant="ghost" className="mobile-only" onPress={() => setPane("list")}>
            返回
          </Button>
        </div>
        <div className="nav-views">
          {views.map(([id, name, icon]) => (
            <Button
              variant={view === id ? "secondary" : "ghost"}
              key={id}
              aria-current={view === id ? "page" : undefined}
              onPress={() => navigate(id)}
            >
              <i aria-hidden="true">
                {id === "today" ? <span className="calendar-day">{today.slice(-2)}</span> : icon}
              </i>
              {name}
              <small>{data.tasks.filter((t) => inView(t, id)).length || ""}</small>
            </Button>
          ))}
          <Button
            variant={showBin ? "secondary" : "ghost"}
            aria-current={showBin ? "page" : undefined}
            onPress={() => navigate("bin")}
          >
            <i aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
              </svg>
            </i>
            回收站
          </Button>
        </div>
        <div className="rail-heading">
          我的清单
          <Button
            variant="ghost"
            size="sm"
            isIconOnly
            aria-label="新建清单"
            onPress={() => {
              setListEdit("new");
              setListError("");
              setListName("");
            }}
          >
            ＋
          </Button>
        </div>
        <div className="nav-views">
          {data.lists.map((l) => (
            <Button
              variant={personal === l.id ? "secondary" : "ghost"}
              key={l.id}
              aria-current={personal === l.id ? "page" : undefined}
              onPress={() => navigate("list:" + l.id)}
            >
              <i aria-hidden="true">{l.id === inbox ? "▱" : "≡"}</i>
              {l.name}
              <small>
                {data.tasks.filter((t) => (t.listId ?? inbox) === l.id && !t.done).length || ""}
              </small>
            </Button>
          ))}
        </div>
        {listEdit !== null && (
          <form className="list-editor" onSubmit={saveList}>
            <Input
              aria-label="清单名称"
              placeholder="清单名称"
              maxLength={80}
              autoFocus
              value={listName}
              onChange={(e) => setListName(e.target.value)}
            />
            <Button size="sm" type="submit" isPending={savingList} isDisabled={!listName.trim()}>
              保存
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              isDisabled={savingList}
              onPress={() => setListEdit(null)}
            >
              取消
            </Button>
            {listError && <p role="alert">{listError}</p>}
          </form>
        )}
        {tags.length > 0 && (
          <>
            <div className="rail-heading">标签</div>
            <div className="tag-cloud">
              {tags.map((t) => (
                <Button
                  size="sm"
                  variant={tag === t ? "secondary" : "ghost"}
                  key={t}
                  className={tag === t ? "chosen" : ""}
                  onPress={() => navigate("all", t)}
                >
                  # {t}
                </Button>
              ))}
            </div>
          </>
        )}
        <div className="rail-foot">
          <ThemeControl />
          <Button
            variant="tertiary"
            size="sm"
            onPress={notify}
            isDisabled={notifications !== "default"}
          >
            {notifications === "granted"
              ? "✓ 浏览器通知已开启"
              : notifications === "denied"
                ? "浏览器已阻止通知"
                : notifications === "unsupported"
                  ? "使用应用内提醒"
                  : "开启浏览器通知"}
          </Button>
          <small>{data.timeZone}</small>
        </div>
      </nav>
      <main className="planner-main">
        <div className="toolbar">
          <Button
            variant="tertiary"
            isIconOnly
            className="mobile-only"
            aria-label="打开导航"
            onPress={() => setPane("nav")}
          >
            ☰
          </Button>
          <Input
            className="search"
            type="search"
            aria-label={showBin ? "搜索回收站" : "搜索任务"}
            placeholder={showBin ? "搜索回收站" : "搜索任务、清单或标签"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!showBin && (
            <Button
              variant={filtered || filters ? "secondary" : "tertiary"}
              aria-expanded={filters}
              aria-controls="task-filters"
              className={filtered ? "selected-filter" : ""}
              onPress={() => setFilters(!filters)}
            >
              筛选{filtered ? " •" : ""}
            </Button>
          )}
          <Button variant="secondary" className="mobile-only" onPress={() => setPane("chat")}>
            小明
          </Button>
        </div>
        {!showBin && (
          <div id="task-filters" className="filter-disclosure" inert={!filters}>
            <div className="filter-clip">
              <div className="filters" role="group" aria-label="任务筛选">
                <ChoiceField
                  searchable
                  label="清单"
                  value={listFilter}
                  onChange={setListFilter}
                  choices={[
                    { value: "", label: "全部清单" },
                    ...data.lists.map((l) => ({ value: l.id, label: l.name })),
                  ]}
                />
                <ChoiceField
                  searchable
                  label="标签"
                  value={tag}
                  onChange={setTag}
                  choices={[{ value: "", label: "全部标签" }, ...options(tags)]}
                />
                <ChoiceField
                  label="优先级"
                  value={priority}
                  onChange={setPriority}
                  choices={[{ value: "", label: "全部优先级" }, ...options(priorities)]}
                />
                <ChoiceField
                  label="完成状态"
                  value={status}
                  onChange={setStatus}
                  choices={[
                    { value: "", label: "全部状态" },
                    { value: "open", label: "待办" },
                    { value: "done", label: "已完成" },
                  ]}
                />
              </div>
            </div>
          </div>
        )}
        {showBin ? (
          <TaskBin items={bin} planner={data} query={query} act={act} />
        ) : (
          <div className="list-scroll" hidden={!!selectedTask}>
            {due.length > 0 && (
              <section className="reminders">
                <Button
                  variant="ghost"
                  onPress={() => setRemindersOpen(!remindersOpen)}
                  aria-expanded={remindersOpen}
                >
                  到点提醒 · {due.length} {remindersOpen ? "▾" : "▸"}
                </Button>
                {remindersOpen &&
                  due.map((t) => (
                    <div key={t.id}>
                      <span>
                        {t.title}
                        <small>{pendingReminder(t)?.replace("T", " ")}</small>
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          void act("planner/tasks/" + t.id, "PATCH", { changes: { done: true } })
                        }
                      >
                        完成
                      </Button>
                      <Button
                        size="sm"
                        variant="tertiary"
                        onPress={() =>
                          void act("planner/reminders/" + t.id, "POST", {
                            at: pendingReminder(t),
                            action: "snooze",
                          })
                        }
                      >
                        稍后 10 分钟
                      </Button>
                    </div>
                  ))}
              </section>
            )}
            <div className="view-head">
              <div key={view}>
                <h1>{label}</h1>
                <p>
                  {new Intl.DateTimeFormat("zh-CN", { dateStyle: "full", timeZone: "UTC" }).format(
                    new Date(today + "T12:00:00Z"),
                  )}
                </p>
              </div>
              {personal && personal !== inbox && (
                <Dropdown>
                  <Button ref={listMenu} variant="tertiary" isIconOnly aria-label="清单操作">
                    ···
                  </Button>
                  <Dropdown.Popover>
                    <Dropdown.Menu aria-label="清单操作">
                      <Dropdown.Item
                        id="rename"
                        onAction={() => {
                          setListEdit(personal);
                          setListError("");
                          setListName(label);
                          setPane("nav");
                        }}
                      >
                        重命名清单
                      </Dropdown.Item>
                      <Dropdown.Item
                        id="delete"
                        variant="danger"
                        onAction={() => setDeleteList(true)}
                      >
                        删除清单
                      </Dropdown.Item>
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              )}
              <SortMenu choice={sort} methods={taskMethods} onChange={changeSort} />
            </div>
            <form className="capture" onSubmit={create}>
              <Button
                type="submit"
                isIconOnly
                isDisabled={saving || !draft.trim()}
                aria-label="添加任务"
              >
                ＋
              </Button>
              <Input
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
            {captureError && <p role="alert">{captureError}</p>}
            {ready ? (
              <TaskList
                items={items}
                sort={sort}
                refresh={refresh}
                tasks={orderedTasks}
                lists={data.lists}
                view={view}
                today={today}
                open={open}
                requestDelete={setDeleteTaskId}
                deleting={deleteTaskId}
                act={act}
              />
            ) : (
              <p role="status">正在读取清单…</p>
            )}
          </div>
        )}
        {selectedTask && (
          <TaskEditor
            key={selectedTask.id}
            task={selectedTask}
            data={data}
            act={act}
            close={back}
            open={open}
            requestDelete={setDeleteTaskId}
          />
        )}
      </main>
      {deleteTask && (
        <ConfirmAction
          key={deleteTask.id}
          open
          close={() => setDeleteTaskId(null)}
          title={`删除「${deleteTask.title}」？`}
          consequence={
            "移入回收站后可在 30 天内恢复。" +
            (deleteTask.repeat && !deleteTask.done
              ? "后续任务将暂停生成，已完成的记录会保留。"
              : data.tasks.some((t) => t.parentId === deleteTask.id)
                ? "子任务将作为独立任务保留在原清单中。"
                : "")
          }
          action="删除任务"
          confirm={async () => {
            if (!(await act("tasks/" + deleteTask.id, "DELETE"))) return false;
            setDeleteTaskId(null);
            if (selected === deleteTask.id) back();
            return true;
          }}
        />
      )}
      <ConfirmAction
        open={deleteList}
        title={`删除「${label}」？`}
        action="删除清单"
        consequence="清单内的任务将移入收件箱。"
        close={() => {
          setDeleteList(false);
          listMenu.current?.focus();
        }}
        confirm={async () => {
          if (!personal || !(await act("planner/lists/" + personal, "DELETE"))) return false;
          navigate("list:" + inbox);
          capture.current?.focus();
          return true;
        }}
      />
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
