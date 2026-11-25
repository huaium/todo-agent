import { useEffect, useLayoutEffect, useState } from "react";
import { applyTheme, readTheme, systemTheme, themeKey, type ThemeMode } from "./appearance.ts";
import { ChoiceField } from "./PlannerControls.tsx";

const themes = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "auto", label: "跟随系统" },
] satisfies { value: ThemeMode; label: string }[];

export function ThemeControl() {
  const [mode, setMode] = useState(readTheme);

  useLayoutEffect(() => {
    const sync = () => applyTheme(mode);
    sync();
    if (mode === "auto") {
      systemTheme.addEventListener("change", sync);
      return () => systemTheme.removeEventListener("change", sync);
    }
  }, [mode]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === themeKey || event.key === null) setMode(readTheme());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function select(value: string) {
    const theme = themes.find((item) => item.value === value);
    if (!theme) return;
    setMode(theme.value);
    try {
      localStorage.setItem(themeKey, theme.value);
    } catch (error) {
      // Storage can be blocked or full. Keep the choice for this tab.
      if (
        !(
          error instanceof DOMException &&
          ["SecurityError", "QuotaExceededError"].includes(error.name)
        )
      )
        throw error;
    }
  }

  return <ChoiceField label="主题" value={mode} choices={themes} onChange={select} />;
}
