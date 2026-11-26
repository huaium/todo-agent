import { AlertDialog, Button, ComboBox, Input, Label, ListBox, Select } from "@heroui/react";
import { useState } from "react";

export interface Choice {
  value: string;
  label: string;
}
export function options(values: readonly string[]): Choice[] {
  return values.map((value) => ({ value, label: value }));
}

export function ChoiceField({
  label,
  value,
  choices,
  onChange,
  searchable,
  disabled,
}: {
  label: string;
  value: string;
  choices: Choice[];
  onChange(value: string): void;
  searchable?: boolean;
  disabled?: boolean;
}) {
  // Prefix every key so the empty option and user-defined tags are both selectable.
  const items = (
    <ListBox items={choices} renderEmptyState={() => "没有匹配项"}>
      {(item) => (
        <ListBox.Item id={"v:" + item.value} textValue={item.label}>
          {item.label}
          <ListBox.ItemIndicator />
        </ListBox.Item>
      )}
    </ListBox>
  );
  const change = (key: string | number | null) =>
    onChange(key === null ? "" : String(key).slice(2));
  if (searchable)
    return (
      <ComboBox
        selectedKey={"v:" + value}
        onSelectionChange={change}
        isDisabled={disabled}
        menuTrigger="focus"
      >
        <Label>{label}</Label>
        <ComboBox.InputGroup>
          <Input />
          <ComboBox.Trigger />
        </ComboBox.InputGroup>
        <ComboBox.Popover>{items}</ComboBox.Popover>
      </ComboBox>
    );
  return (
    <Select value={"v:" + value} onChange={change} isDisabled={disabled}>
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>{items}</Select.Popover>
    </Select>
  );
}

export function ConfirmAction({
  title,
  consequence,
  action,
  open,
  close,
  confirm,
}: {
  title: string;
  consequence: string;
  action: string;
  open: boolean;
  close(): void;
  confirm(): Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  function dismiss() {
    setFailed(false);
    close();
  }
  return (
    <AlertDialog.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !busy) dismiss();
      }}
      isKeyboardDismissDisabled={busy}
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>{title}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            {consequence}
            {failed && <p role="alert">操作未完成，请重试。</p>}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button autoFocus variant="tertiary" isDisabled={busy} onPress={dismiss}>
              取消
            </Button>
            <Button
              variant="danger"
              isPending={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  if (await confirm()) dismiss();
                  else setFailed(true);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {action}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
