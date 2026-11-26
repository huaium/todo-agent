import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { modelBytes, type DownloadCommand, type DownloadState } from "./model.ts";

export function useSpeechModel() {
  const [state, setState] = useState<DownloadState>({ status: "checking", bytes: 0 });
  const worker = useRef<Worker | null>(null);
  useEffect(() => {
    if (!window.isSecureContext || !navigator.storage?.getDirectory || !navigator.locks) {
      setState({
        status: "error",
        bytes: 0,
        error:
          "此浏览器无法保存本地模型，请使用支持本地文件存储的浏览器并通过 HTTPS 或 localhost 打开。",
      });
      return;
    }
    const manager = new Worker("/assets/speech/download.js", { type: "module" });
    manager.onmessage = ({ data }: MessageEvent<DownloadState>) => setState(data);
    manager.onerror = () =>
      setState({ status: "error", bytes: 0, error: "无法加载模型管理器，请刷新重试。" });
    worker.current = manager;
    manager.postMessage("inspect");
    return () => {
      worker.current = null;
      manager.terminate();
    };
  }, []);
  function command(action: DownloadCommand) {
    if (!worker.current) return;
    setState((prev) => ({ ...prev, status: "checking", error: undefined }));
    worker.current.postMessage(action);
  }
  return { state, command, available: !!worker.current };
}

export function ModelDownload({
  model,
  open,
  close,
}: {
  model: ReturnType<typeof useSpeechModel>;
  open: boolean;
  close(): void;
}) {
  const { state, command, available } = model;
  const { status, bytes } = state;
  const size = (modelBytes / 1e6).toFixed(1);
  const progress = bytes > 0 || status === "downloading";
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>语音输入模型</Modal.Heading>
          </Modal.Header>
          <Modal.CloseTrigger aria-label="关闭模型管理" />
          <Modal.Body className="speech-model-body">
            <strong>Whisper Small</strong>
            <p>中文语音在此设备上识别。首次下载模型和运行文件约 {size} MB。</p>
            {progress && (
              <>
                <progress aria-label="模型下载进度" max={modelBytes} value={bytes} />
                <small>
                  {(bytes / 1e6).toFixed(1)} / {size} MB
                </small>
              </>
            )}
            <p role="status">
              {
                {
                  checking: "正在检查模型…",
                  empty: "尚未下载",
                  downloading: "正在下载…",
                  paused: "已暂停，可从上次进度继续。",
                  ready: "模型已就绪",
                  elsewhere: "其他标签页正在管理模型。",
                  error: state.error,
                }[status]
              }
            </p>
          </Modal.Body>
          <Modal.Footer>
            {status === "empty" && (
              <>
                <Button variant="tertiary" onPress={close}>
                  暂不下载
                </Button>
                <Button onPress={() => command("start")}>下载模型</Button>
              </>
            )}
            {(status === "downloading" ||
              status === "paused" ||
              (status === "error" && available)) && (
              <>
                <Button variant="tertiary" onPress={() => command("stop")}>
                  停止并清除
                </Button>
                {status === "downloading" ? (
                  <Button onPress={() => command("pause")}>暂停下载</Button>
                ) : (
                  <Button onPress={() => command("start")}>
                    {bytes ? "继续下载" : "重新下载"}
                  </Button>
                )}
              </>
            )}
            {status === "ready" && (
              <>
                <Button variant="tertiary" onPress={() => command("stop")}>
                  移除模型
                </Button>
                <Button onPress={close}>完成</Button>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
