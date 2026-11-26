import OpenAI from "openai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";
export const deepseek = deepseekProvider();
const catalog = deepseek.getModels();
// DeepSeek also accepts deployment aliases that may be newer than Pi's catalog.
export const chatModel = catalog.find((entry) => entry.id === model) ?? {
  ...catalog.find((entry) => entry.id === "deepseek-flash")!,
  id: model,
  name: model,
};

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
}
