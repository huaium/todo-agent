import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatPage, ConversationCommand } from "../shared/chat.ts";
import { api } from "./planner-client.ts";

function pageUrl(current?: ChatPage, older = false) {
  const query = new URLSearchParams({ window: "1" });
  if (current) {
    query.set("history", current.history);
    if (older) query.set("before", String(current.first));
    else {
      query.set("since", String(current.last));
      query.set("after", String(current.revision));
    }
  }
  return "chat?" + query;
}

function mergeChatPage(
  current: ChatPage | undefined,
  next: ChatPage,
  requested?: ChatPage,
): ChatPage {
  if (!current) return next;
  if (current.history !== next.history)
    return current.history === requested?.history ? next : current;
  if (next.mode === "older") {
    if (requested?.first !== current.first || !next.messages.length) return current;
    return {
      ...current,
      first: next.first,
      hasOlder: next.hasOlder,
      messages: [...next.messages, ...current.messages],
    };
  }
  if (current.revision >= next.revision) return current;
  if (next.mode === "latest") return next;
  return {
    ...next,
    first: current.first || next.first,
    hasOlder: current.hasOlder,
    messages: [...current.messages, ...next.messages.filter((m) => m.seq > current.last)],
  };
}

export function useConversation() {
  const [state, setState] = useState<ChatPage>();
  const [error, setError] = useState("");
  const [active, setActive] = useState<ConversationCommand>();
  const sending = useRef(false);
  const latest = useRef<ChatPage>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const readingOlder = useRef(false);
  const bus = useRef<BroadcastChannel | null>(null);

  const receive = useCallback((next: ChatPage, requested?: ChatPage) => {
    latest.current = mergeChatPage(latest.current, next, requested);
    setState(latest.current);
  }, []);
  const reload = useCallback(async () => {
    try {
      const previous = latest.current;
      const next = await api<ChatPage | undefined>(pageUrl(previous));
      if (next) receive(next, previous);
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

  async function loadOlder() {
    const current = latest.current;
    if (!current?.hasOlder || readingOlder.current) return;
    readingOlder.current = true;
    setLoadingOlder(true);
    try {
      receive(await api<ChatPage>(pageUrl(current, true)), current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法读取更早的消息。");
    } finally {
      readingOlder.current = false;
      setLoadingOlder(false);
    }
  }

  async function submit(command: ConversationCommand) {
    if (sending.current) return false;
    sending.current = true;
    setActive(command);
    setError("");
    const previous = latest.current;
    try {
      receive(await api<ChatPage>(pageUrl(previous), "POST", command), previous);
      return true;
    } catch (e) {
      const restored = await reload();
      setError(e instanceof Error ? e.message : "无法保存对话。");
      return (
        command.action === "send" &&
        !!previous &&
        restored?.history === previous.history &&
        restored.messages.some(
          (m) => m.seq > previous.last && m.role === "user" && m.content === command.text,
        )
      );
    } finally {
      sending.current = false;
      setActive(undefined);
      bus.current?.postMessage("changed");
    }
  }
  return { state, active, error, reload, submit, loadOlder, loadingOlder };
}
