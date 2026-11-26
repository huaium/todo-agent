import { useEffect, useRef } from "react";

export function usePlannerKeyboard(editing: boolean, setPane: (pane: string) => void) {
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
      const switchPane =
        key === "f6" && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
      if (!(search && !editing) && !switchPane) return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .sortable-row[data-moving]',
        )
      )
        return;
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
        const selector = toChat
          ? ".composer textarea"
          : editing
            ? ".editor button"
            : "input.search";
        const field = document.querySelector<HTMLElement>(selector);
        field?.focus();
        if (search && field instanceof HTMLInputElement) field.select();
      });
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, setPane]);
}
