import { useEffect, useState } from "react";
import { Description, Label, Modal, Switch } from "@heroui/react";
import { IconButton } from "./IconButton.tsx";

const preferenceKey = "tokenow.chat.sendShortcut";

function readShiftToSend() {
  try {
    return localStorage.getItem(preferenceKey) === "Shift+Enter";
  } catch (error) {
    if (error instanceof DOMException && error.name === "SecurityError") return false;
    throw error;
  }
}

export function useSendShortcut() {
  const [shiftToSend, setShiftToSend] = useState(readShiftToSend);
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === preferenceKey || event.key === null) setShiftToSend(readShiftToSend());
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function choose(shift: boolean) {
    setShiftToSend(shift);
    try {
      localStorage.setItem(preferenceKey, shift ? "Shift+Enter" : "Enter");
    } catch (error) {
      if (
        !(
          error instanceof DOMException &&
          ["SecurityError", "QuotaExceededError"].includes(error.name)
        )
      )
        throw error;
    }
  }
  return [shiftToSend, choose] as const;
}

export function ChatSettings({
  shiftToSend,
  onChange,
}: {
  shiftToSend: boolean;
  onChange(shift: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        size="sm"
        variant="ghost"
        icon="settings"
        label="聊天设置"
        aria-haspopup="dialog"
        onPress={() => setOpen(true)}
      />
      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container size="sm">
          <Modal.Dialog className="chat-settings">
            <Modal.Header>
              <Modal.Heading>聊天设置</Modal.Heading>
            </Modal.Header>
            <Modal.CloseTrigger aria-label="关闭设置" />
            <Modal.Body>
              <Switch isSelected={shiftToSend} onChange={onChange}>
                <Switch.Content>
                  <Label>使用 Shift + Enter 发送</Label>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
                <Description>{shiftToSend ? "Enter" : "Shift + Enter"} 换行</Description>
              </Switch>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
