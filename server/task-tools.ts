import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import { createTaskSchema, updateTaskSchema } from "./tasks.ts";

export interface TaskTool {
  definition: ChatCompletionFunctionTool;
  execute(input: string): Promise<unknown>;
}

export function taskTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.output<S>) => Promise<unknown>,
): TaskTool {
  const { $schema: _dialect, ...parameters } = z.toJSONSchema(schema);
  return {
    definition: { type: "function", function: { name, description, parameters } },
    async execute(input) {
      let args: unknown;
      try {
        args = JSON.parse(input);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { error: "工具参数需要有效的 JSON 对象。" };
      }
      const result = schema.safeParse(args);
      if (!result.success)
        return { error: result.error.issues.map(({ path, message }) => ({ path, message })) };
      return run(result.data);
    },
  };
}

export function taskTools(port: number): TaskTool[] {
  const collection = `http://127.0.0.1:${port}/api/tasks`;
  async function request(method: string, id?: string, body?: unknown) {
    const url = id === undefined ? collection : `${collection}/${encodeURIComponent(id)}`;
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 204) return { deleted: id };
    if (!response.ok && response.status !== 400 && response.status !== 404) {
      throw new Error(`任务接口返回 HTTP ${response.status}`);
    }
    return response.json();
  }
  const id = z.string().min(1).describe("从任务清单读取的任务 ID");
  return [
    taskTool("listTasks", "读取当前所有任务及其完成状态", z.strictObject({}), () => request("GET")),
    taskTool("createTask", "创建一条未完成的任务", createTaskSchema, ({ title }) =>
      request("POST", undefined, { title }),
    ),
    taskTool(
      "updateTask",
      "修改指定任务的标题或完成状态",
      z.strictObject({ id, changes: updateTaskSchema }),
      ({ id, changes }) => request("PATCH", id, changes),
    ),
    taskTool("deleteTask", "删除用户指定的单条任务", z.strictObject({ id }), ({ id }) =>
      request("DELETE", id),
    ),
  ];
}
