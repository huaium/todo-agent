export async function requestTask(
  port: number,
  method: string,
  id?: string,
  body?: unknown,
  resource = "tasks",
  version?: string,
) {
  const collection = `http://127.0.0.1:${port}/api/${resource}`;
  const response = await fetch(
    id === undefined ? collection : `${collection}/${encodeURIComponent(id)}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(version && { "If-Match": `"${version}"` }),
      },
      body: JSON.stringify(body),
    },
  );
  if (response.status === 204) return { deleted: id };
  if (![400, 404, 412].includes(response.status) && !response.ok)
    throw new Error(`任务接口返回 HTTP ${response.status}`);
  return response.json();
}
