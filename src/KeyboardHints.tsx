import type { ReactNode } from "react";

const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const searchKeys = apple ? "⌘ K" : "Ctrl K";
export const chatKeys = apple ? "⌘ /" : "Ctrl /";

export function KeyHint({ keys, children }: { keys: string; children?: ReactNode }) {
  return (
    <span className="key-hint">
      <kbd>{keys}</kbd>
      {children}
    </span>
  );
}

export function ShortcutField({ keys, children }: { keys?: string; children: ReactNode }) {
  return (
    <label className="shortcut-field">
      {children}
      {keys && (
        <span className="field-hints" aria-hidden="true">
          <KeyHint keys={keys} />
        </span>
      )}
    </label>
  );
}
