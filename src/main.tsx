import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "@heroui/react";

createRoot(document.getElementById("root")!).render(
  <I18nProvider locale="zh-CN">
    <App />
  </I18nProvider>,
);
