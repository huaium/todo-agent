/// <reference lib="webworker" />
import {
  modelFiles,
  modelDirectory,
  modelUrl,
  modelBytes,
  openModelDirectory,
  type DownloadCommand,
  type DownloadState,
} from "./model.ts";

let controller: AbortController | undefined;
let operation: Promise<void> | undefined;
let bytes = 0;
let lastProgress = 0;
const changes = new BroadcastChannel(modelDirectory);
let recheck: ReturnType<typeof setTimeout> | undefined;
function publish(status: DownloadState["status"], error?: string) {
  clearTimeout(recheck);
  if (status === "elsewhere") {
    // A closed tab releases its lock without broadcasting the final progress.
    recheck = setTimeout(() => {
      if (!operation) start("inspect");
    }, 1500);
  }
  self.postMessage({ status, bytes, error } satisfies DownloadState);
}
const localName = (name: string) => name.replaceAll("/", "--");

async function savedBytes(dir: FileSystemDirectoryHandle, name: string) {
  try {
    const handle = await dir.getFileHandle(localName(name));
    return (await handle.getFile()).size;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return 0;
    throw error;
  }
}
async function inspect(dir: FileSystemDirectoryHandle) {
  let saved = 0;
  for (const [name, size] of modelFiles) {
    const length = await savedBytes(dir, name);
    if (length > size) throw new Error("模型文件大小异常，请清除后重新下载。");
    saved += length;
  }
  bytes = saved;
  return saved === modelBytes ? "ready" : saved ? "paused" : "empty";
}

async function download(dir: FileSystemDirectoryHandle, signal: AbortSignal) {
  publish("downloading");
  for (const [name, size] of modelFiles) {
    signal.throwIfAborted();
    const offset = await savedBytes(dir, name);
    if (offset === size) continue;
    const url = new URL(modelUrl(name), self.location.origin);
    if (offset) url.searchParams.set("resume", String(offset));
    const response = await fetch(url, {
      signal,
      cache: "no-store",
      credentials: "omit",
      headers: offset ? { Range: "bytes=" + offset + "-" } : {},
    });
    if (!response.ok || !response.body)
      throw new Error("下载失败（HTTP " + response.status + "），请重试。");
    if (
      response.status === 206 &&
      response.headers.get("content-range") !== `bytes ${offset}-${size - 1}/${size}`
    )
      throw new Error("服务器返回的文件范围不正确，请重试。");
    const handle = await dir.getFileHandle(localName(name), { create: true });
    const file = await handle.createSyncAccessHandle();
    try {
      let position = offset;
      if (offset && response.status === 200) {
        // The origin ignored Range. Replace this file, keeping previously completed files.
        file.truncate(0);
        bytes -= offset;
        position = 0;
      }
      const reader = response.body.getReader();
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        if (position + value.length > size) throw new Error("模型文件超出预期大小。");
        const written = file.write(value, { at: position });
        if (written !== value.length) throw new Error("设备空间不足，未能写入模型。");
        position += written;
        bytes += written;
        if (performance.now() - lastProgress >= 100) {
          publish("downloading");
          lastProgress = performance.now();
        }
      }
      if (position !== size) throw new Error("下载中断，可以继续下载。");
    } finally {
      file.close();
    }
  }
}

async function run(command: "inspect" | "start" | "stop", signal: AbortSignal) {
  try {
    await navigator.locks.request(modelDirectory, { ifAvailable: true }, async (lock) => {
      if (!lock) return publish("elsewhere");
      const dir = await openModelDirectory();
      if (command === "stop") {
        await (
          await navigator.storage.getDirectory()
        ).removeEntry(modelDirectory, { recursive: true });
        bytes = 0;
        publish("empty");
      } else {
        const status = await inspect(dir);
        if (command === "start" && status !== "ready") {
          changes.postMessage("busy");
          await download(dir, signal);
          publish("ready");
        } else publish(status);
      }
    });
  } catch (error) {
    if (signal.aborted) publish(bytes ? "paused" : "empty");
    else publish("error", error instanceof Error ? error.message : "无法管理语音模型。");
  }
}

function start(command: "inspect" | "start" | "stop") {
  controller = new AbortController();
  operation = run(command, controller.signal).finally(() => {
    operation = undefined;
    controller = undefined;
    if (command !== "inspect") changes.postMessage("changed");
  });
}
self.onmessage = async ({ data }: MessageEvent<DownloadCommand>) => {
  if (data === "pause" || data === "stop") {
    controller?.abort();
    await operation;
    start(data === "stop" ? "stop" : "inspect");
  } else if (!operation) start(data);
};
changes.onmessage = ({ data }) => {
  if (operation) return;
  if (data === "busy") publish("elsewhere");
  else start("inspect");
};
