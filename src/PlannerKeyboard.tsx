import { useEffect } from "react";

export function usePlannerKeyboard(editing: boolean, setPane: (pane: string) => void) {
  useEffect(() => {
    if (editing) return;
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
      if (!search) return;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .sortable-row[data-moving]',
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      setPane("list");
      requestAnimationFrame(() => {
        const field = document.querySelector<HTMLInputElement>("input.search");
        field?.focus();
        field?.select();
      });
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [editing, setPane]);
}
