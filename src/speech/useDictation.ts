import { useEffect, useRef, useState } from "react";
import { openModelDirectory } from "./model.ts";

async function decodeRecording(blob: Blob) {
  const decoder = new OfflineAudioContext(1, 1, 16000);
  const audio = await decoder.decodeAudioData(await blob.arrayBuffer());
  const samples = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const input = audio.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] += input[i] / audio.numberOfChannels;
  }
  return samples;
}

function release(stream: MediaStream | undefined) {
  stream?.getTracks().forEach((track) => track.stop());
}
type Phase = "idle" | "permission" | "recording" | "recognizing";
export function useDictation(insert: (text: string) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const worker = useRef<Worker | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const generation = useRef(0);

  function cancel() {
    generation.current++;
    clearTimeout(timer.current);
    const active = recorder.current;
    if (active) {
      active.onstop = null;
      active.onerror = null;
      if (active.state !== "inactive") active.stop();
      release(active.stream);
      recorder.current = null;
    }
    worker.current?.terminate();
    worker.current = null;
    setPhase("idle");
  }
  useEffect(() => {
    window.addEventListener("pagehide", cancel);
    return () => {
      window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, []);

  async function record() {
    if (phase !== "idle") return;
    const turn = ++generation.current;
    function fail(message: string) {
      if (turn !== generation.current) return;
      cancel();
      setError(message);
    }
    setError("");
    setPhase("permission");
    let stream: MediaStream | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined")
        throw new Error("此浏览器不支持麦克风录音。请使用 HTTPS 或 localhost。");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      if (generation.current !== turn) {
        release(stream);
        return;
      }
      const active = new MediaRecorder(stream);
      recorder.current = active;
      const chunks: Blob[] = [];
      active.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      active.onerror = () => fail("录音中断，请检查麦克风后重试。");
      active.onstop = async () => {
        clearTimeout(timer.current);
        release(active.stream);
        recorder.current = null;
        if (generation.current !== turn) return;
        setPhase("recognizing");
        try {
          const samples = await decodeRecording(new Blob(chunks, { type: active.mimeType }));
          if (!samples.some((sample) => Math.abs(sample) > 0.001))
            throw new Error("未检测到声音，请再试一次。");
          const files = await openModelDirectory();
          if (generation.current !== turn) return;
          const engine = (worker.current ??= new Worker("/assets/speech/recognize.js", {
            type: "module",
          }));
          engine.onerror = () => fail("无法启动语音识别，请重试。");
          engine.onmessage = ({ data }: MessageEvent<{ text?: string; error?: string }>) => {
            if (generation.current !== turn) return;
            if (data.error || !data.text)
              return fail(
                data.error ? "语音识别失败：" + data.error : "未识别到文字，请再试一次。",
              );
            insert(data.text);
            setPhase("idle");
          };
          engine.postMessage({ files, samples }, [samples.buffer]);
        } catch (error) {
          fail(error instanceof Error ? error.message : "无法读取录音，请重试。");
        }
      };
      active.start();
      setPhase("recording");
      timer.current = window.setTimeout(() => {
        if (active.state === "recording") active.stop();
      }, 30000);
    } catch (error) {
      release(stream);
      fail(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "请允许使用麦克风后再试。"
          : error instanceof Error
            ? error.message
            : "无法录音。",
      );
    }
  }
  function finish() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }
  return { phase, error, record, finish, cancel };
}
