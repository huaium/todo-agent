import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation, ConversationCommand } from "../shared/chat.ts";
import { api } from "./planner-client.ts";

export function useConversation() {
  const [state, setState] = useState<Conversation>();
  const [error, setError] = useState("");
  const [active, setActive] = useState<ConversationCommand>();
  const sending = useRef(false);
  const latest = useRef<Conversation>(undefined);
  const bus = useRef<BroadcastChannel | null>(null);

  const receive = useCallback((next: Conversation) => {
    if (latest.current && latest.current.revision >= next.revision) return;
    latest.current = next;
    setState(next);
  }, []);
  const reload = useCallback(async () => {
    try {
      const previous = latest.current;
      const next = await api<Conversation | undefined>(
        previous ? "chat?after=" + previous.revision : "chat",
      );
      if (next) receive(next);
      setError("");
      return latest.current;
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取对话。");
    }
  }, [receive]);
  useEffect(() => {
    const channel = new BroadcastChannel("xiaoming-chat");
    bus.current = channel;
    channel.onmessage = reload;
    window.addEventListener("focus", reload);
    void reload();
    return () => {
      window.removeEventListener("focus", reload);
      channel.close();
      bus.current = null;
    };
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(reload, state?.pending ? 1000 : 15000);
    return () => clearInterval(timer);
  }, [reload, state?.pending]);

  async function submit(command: ConversationCommand) {
    if (sending.current) return false;
    sending.current = true;
    setActive(command);
    setError("");
    try {
      receive(await api<Conversation>("chat", "POST", command));
      return true;
    } catch (e) {
      const restored = await reload();
      setError(e instanceof Error ? e.message : "无法保存对话。");
      return (
        command.action === "send" &&
        restored?.revision !== command.revision &&
        restored?.messages[state?.messages.length ?? 0]?.content === command.text
      );
    } finally {
      sending.current = false;
      setActive(undefined);
      bus.current?.postMessage("changed");
    }
  }
  return { state, active, error, reload, submit };
}
