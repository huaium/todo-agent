import { env, pipeline } from "@huggingface/transformers";
import { ConverterFactory } from "opencc-js/core";
import { to } from "opencc-js/preset/t2cn";

const toSimplified = ConverterFactory(to.cn);

// Model fetches resolve exclusively to the files the user downloaded.
async function loadRecognizer(files: FileSystemDirectoryHandle) {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.localModelPath = "/models/";
  env.fetch = async (url) => {
    const path = new URL(url, location.origin).pathname;
    const prefix = "/models/whisper-small/";
    if (!path.startsWith(prefix)) throw new Error("无法读取本地语音模型。");
    try {
      const file = await files.getFileHandle(path.slice(prefix.length).replaceAll("/", "--"));
      return new Response(await file.getFile());
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return new Response(null, { status: 404 });
      throw error;
    }
  };
  const wasm = env.backends.onnx.wasm!;
  wasm.numThreads = 1;
  wasm.wasmPaths = {
    mjs: new URL("/assets/speech/ort-wasm-simd-threaded.asyncify.mjs", location.origin).href,
  };
  const binary = await files.getFileHandle("runtime.wasm");
  wasm.wasmBinary = await (await binary.getFile()).arrayBuffer();
  return pipeline("automatic-speech-recognition", "whisper-small", {
    device: "wasm",
    dtype: "q8",
    local_files_only: true,
  });
}

let recognizer: Awaited<ReturnType<typeof loadRecognizer>> | undefined;
self.onmessage = async ({
  data,
}: MessageEvent<{ files: FileSystemDirectoryHandle; samples: Float32Array }>) => {
  try {
    recognizer ??= await loadRecognizer(data.files);
    const result = await recognizer(data.samples, {
      language: "zh",
      task: "transcribe",
      return_timestamps: false,
    });
    if (Array.isArray(result)) throw new Error("语音识别结果格式异常。");
    self.postMessage({ text: toSimplified(result.text.trim()) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "语音识别失败。" });
  }
};
