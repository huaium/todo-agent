import { useEffect, useRef } from "react";
import { Button, Modal } from "@heroui/react";

const primaryAction = ".list-scroll:not([hidden]) [data-task-id] [data-row-primary]:enabled";

export function usePlannerKeyboard(
  editing: boolean,
  bin: boolean,
  setPane: (pane: string) => void,
) {
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        (target !== document.body && !target.closest(".planner-app"))
      )
        return;

      const key = event.key.toLowerCase();
      const search =
        key === "k" && event.ctrlKey !== event.metaKey && !event.shiftKey && !event.altKey;
      const capture =
        event.code === "KeyN" && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey;
      const switchPane = key === "f6" && !event.altKey && !event.metaKey && !event.ctrlKey;
      const jump = (search && !editing) || (capture && !editing && !bin) || switchPane;
      if (!jump) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || editing) return;
        if (!["arrowdown", "arrowup", "home", "end"].includes(key)) return;
        const fromField = target.matches("input.search, .capture input");
        if (!(fromField && key === "arrowdown") && !target.matches(primaryAction)) return;
      }
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .sortable-row[data-moving]',
        )
      )
        return;
      if (jump) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const toChat = switchPane && !target.closest(".chat-pane");
        if (toChat) returnFocus.current = target;
        setPane(toChat ? "chat" : editing ? "editor" : "list");
        requestAnimationFrame(() => {
          const saved = returnFocus.current;
          if (
            switchPane &&
            !toChat &&
            saved &&
            saved !== document.body &&
            saved.isConnected &&
            saved.getClientRects().length &&
            !saved.matches(":disabled")
          ) {
            saved.focus();
            return;
          }
          let selector = primaryAction;
          if (toChat) selector = ".composer textarea";
          else if (search) selector = "input.search";
          else if (capture) selector = ".capture input";
          else if (editing) selector = ".editor button";
          const field =
            document.querySelector<HTMLElement>(selector) ??
            document.querySelector<HTMLElement>("input.search");
          field?.focus();
          if (search && field instanceof HTMLInputElement) field.select();
        });
        return;
      }
      const rows = Array.from(document.querySelectorAll<HTMLElement>(primaryAction));
      if (!rows.length) return;
      event.preventDefault();
      event.stopPropagation();
      const index = rows.indexOf(target);
      const next =
        key === "home"
          ? 0
          : key === "end"
            ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, index + (key === "arrowdown" ? 1 : -1)));
      rows[next].focus();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, bin, setPane]);
}

const shortcuts = [
  ["Ctrl / ⌘ + K", "聚焦搜索框"],
  ["Alt + Shift + N", "快速添加任务"],
  ["F6", "在任务和聊天之间切换"],
  ["↓", "从搜索框或快速添加框进入结果"],
  ["↑ / ↓", "上一个或下一个任务"],
  ["Home / End", "第一个或最后一个任务"],
  ["Enter", "打开聚焦的任务标题"],
  ["X", "在任务标题上切换完成状态"],
  ["空格 → ↑ / ↓ → 空格", "聚焦手动排序行后移动任务，Esc 取消"],
];

export function KeyboardHelp() {
  return (
    <Modal>
      <Button variant="tertiary" size="sm">
        快捷键
      </Button>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>键盘快捷键</Modal.Heading>
            </Modal.Header>
            <Modal.CloseTrigger aria-label="关闭快捷键说明" />
            <Modal.Body>
              <dl className="shortcut-list">
                {shortcuts.map(([keys, description]) => (
                  <div key={keys}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
