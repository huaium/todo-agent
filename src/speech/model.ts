const revision = "36050c46d777d46dc4b5f43f6d90574fc38f8732";
const source = "https://huggingface.co/onnx-community/whisper-small/resolve/" + revision + "/";
export const modelDirectory = "whisper-small-q8-" + revision + "-ort-1.31.0-dev-8d85527a0";
export const modelFiles = [
  ["config.json", 2227],
  ["generation_config.json", 3893],
  ["preprocessor_config.json", 339],
  ["tokenizer.json", 2480466],
  ["tokenizer_config.json", 282683],
  ["onnx/encoder_model_quantized.onnx", 92326160],
  ["onnx/decoder_model_merged_quantized.onnx", 156750845],
  ["runtime.wasm", 26861777],
] as const;
export const modelBytes = modelFiles.reduce((sum, [, size]) => sum + size, 0);
export const modelUrl = (name: string) =>
  name === "runtime.wasm" ? "/assets/speech/ort-wasm-simd-threaded.asyncify.wasm" : source + name;
export function openModelDirectory() {
  return navigator.storage
    .getDirectory()
    .then((root) => root.getDirectoryHandle(modelDirectory, { create: true }));
}
export type DownloadCommand = "inspect" | "start" | "pause" | "stop";
export type DownloadState = {
  status: "checking" | "empty" | "downloading" | "paused" | "ready" | "error" | "elsewhere";
  bytes: number;
  error?: string;
};
