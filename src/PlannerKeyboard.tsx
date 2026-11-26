import { useEffect } from "react";

export function usePlannerKeyboard(editing: boolean, setPane: (pane: string) => void) {
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

      if (event.ctrlKey === event.metaKey || event.altKey) return;
      const search = event.key.toLowerCase() === "k" && !event.shiftKey && !editing;
      const chat = event.key === "/";
      if (!search && !chat) return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .sortable-row[data-moving]',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      setPane(chat ? "chat" : "list");
      requestAnimationFrame(() => {
        if (chat) {
          document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
          return;
        }
        const field = document.querySelector<HTMLInputElement>("input.search");
        field?.focus();
        field?.select();
      });
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, setPane]);
}
