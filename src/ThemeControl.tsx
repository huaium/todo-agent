import { useEffect, useLayoutEffect, useState } from "react";
import { IconButton } from "./IconButton.tsx";
import { applyTheme, readTheme, systemTheme, themeKey, type ThemeMode } from "./appearance.ts";

const themes = {
  auto: { label: "跟随系统", next: "light" },
  light: { label: "浅色", next: "dark" },
  dark: { label: "深色", next: "auto" },
} satisfies Record<ThemeMode, { label: string; next: ThemeMode }>;

export function ThemeControl() {
  const [mode, setMode] = useState(readTheme);
  const { label, next } = themes[mode];
  const description = `主题 · ${label}，切换到${themes[next].label}`;

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

  function cycleTheme() {
    setMode(next);
    try {
      localStorage.setItem(themeKey, next);
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

  return (
    <IconButton
      variant="secondary"
      size="sm"
      onPress={cycleTheme}
      icon={mode}
      label={description}
    />
  );
}
