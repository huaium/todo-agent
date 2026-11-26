export type ThemeMode = "auto" | "light" | "dark";

export const themeKey = "tokenow.theme";
export const systemTheme = matchMedia("(prefers-color-scheme: dark)");

export function readTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" ? value : "auto";
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError") return "auto";
    throw error;
  }
}

export function applyTheme(mode: ThemeMode) {
  const dark = mode === "dark" || (mode === "auto" && systemTheme.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? "dark" : "light";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = root.dataset.theme;
}
