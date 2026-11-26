import type { ReactNode } from "react";

const apple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const searchKeys = apple ? "⌘ K" : "Ctrl K";
export const captureKeys = apple ? "⌥ ⇧ N" : "Alt Shift N";

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
          <span className="field-focus-key">
            <KeyHint keys={keys} />
          </span>
          <span className="field-results-key">
            <KeyHint keys="↓">进入列表</KeyHint>
          </span>
        </span>
      )}
    </label>
  );
}

export function TaskKeyHints({ bin = false }: { bin?: boolean }) {
  return (
    <div className="task-key-hints" title={bin ? "聚焦恢复按钮时可用" : "聚焦任务标题时可用"}>
      <KeyHint keys="↑ ↓">选择</KeyHint>
      <KeyHint keys="Home / End">首尾</KeyHint>
      <KeyHint keys="Enter">{bin ? "恢复" : "打开"}</KeyHint>
      {!bin && <KeyHint keys="X">切换完成</KeyHint>}
    </div>
  );
}
