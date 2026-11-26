import { useEffect, type RefObject } from "react";
import { flushSync } from "react-dom";

export function usePlannerKeyboard(
  editing: boolean,
  setPane: (pane: string) => void,
  focusChat: RefObject<(() => void) | null>,
) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        (target !== document.body && !target.closest(".planner-app, .chat-sheet"))
      )
        return;

      if (event.ctrlKey === event.metaKey || event.altKey) return;
      const search = event.key.toLowerCase() === "k" && !event.shiftKey && !editing;
      const chat = event.key === "/";
      if (!search && !chat) return;
      if (
        document.querySelector(
          '[role="dialog"]:not(.chat-sheet), [role="alertdialog"], [role="menu"], [role="listbox"], .sortable-row[data-moving]',
        )
      )
        return;
      if (search && target.closest(".chat-sheet")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (chat) {
        if (target.closest('.planner-app[data-pane="nav"]'))
          flushSync(() => setPane(editing ? "editor" : "list"));
        focusChat.current?.();
        return;
      }
      setPane("list");
      requestAnimationFrame(() => {
        const field = document.querySelector<HTMLInputElement>("input.search");
        field?.focus();
        field?.select();
      });
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, setPane, focusChat]);
}
