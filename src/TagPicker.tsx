import { ComboBox, InputGroup, Label, ListBox } from "@heroui/react";
import { useRef, useState } from "react";
import { maxTagLength, maxTaskTags } from "../shared/planner.ts";

export function TagPicker({
  tags,
  available,
  onChange,
}: {
  tags: string[];
  available: string[];
  onChange(tags: string[]): void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const name = query.trim();
  const search = name.toLowerCase();
  const selected = new Set(tags.map((tag) => tag.toLowerCase()));
  const matches = available
    .filter(
      (tag) => search && !selected.has(tag.toLowerCase()) && tag.toLowerCase().includes(search),
    )
    .sort(
      (a, b) =>
        Number(b.toLowerCase().startsWith(search)) - Number(a.toLowerCase().startsWith(search)),
    );
  const exact = matches.find((tag) => tag.toLowerCase() === search);
  const items = matches.map((tag) => ({ tag, label: tag }));
  if (name && !exact && !selected.has(search))
    items.push({ tag: name, label: `＋ 创建「${name}」` });
  const full = tags.length >= maxTaskTags;

  function add(tag: string) {
    if (!tag || full) return;
    if (!selected.has(tag.toLowerCase())) onChange([...tags, tag]);
    setQuery("");
  }

  return (
    <ComboBox
      className="tag-picker"
      items={items}
      allowsCustomValue
      selectedKey={null}
      inputValue={query}
      onInputChange={setQuery}
      onSelectionChange={(key) => {
        if (typeof key === "string") add(key);
      }}
      isReadOnly={full}
    >
      <Label>标签</Label>
      <InputGroup className="tag-input">
        {tags.map((tag) => (
          <span className="tag-pill" key={tag}>
            <span>{tag}</span>
            <button
              type="button"
              aria-label={`移除标签「${tag}」`}
              onClick={() => {
                onChange(tags.filter((item) => item !== tag));
                requestAnimationFrame(() => input.current?.focus());
              }}
            >
              ×
            </button>
          </span>
        ))}
        <InputGroup.Input
          ref={input}
          maxLength={maxTagLength}
          placeholder={full ? "已达标签上限" : "查找或创建标签"}
          onCompositionStart={(event) => {
            event.stopPropagation();
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            event.stopPropagation();
            composing.current = false;
          }}
          onKeyDownCapture={(event) => {
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              event.stopPropagation();
              return;
            }
            if (
              event.key === "Enter" &&
              !event.currentTarget.getAttribute("aria-activedescendant")
            ) {
              event.preventDefault();
              event.stopPropagation();
              add(exact ?? name);
            }
          }}
        />
      </InputGroup>
      <ComboBox.Popover>
        <ListBox>
          {(item: { tag: string; label: string }) => (
            <ListBox.Item id={item.tag} textValue={item.label}>
              {item.label}
            </ListBox.Item>
          )}
        </ListBox>
      </ComboBox.Popover>
    </ComboBox>
  );
}
