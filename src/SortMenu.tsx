import { Button, Dropdown, Label, Separator } from "@heroui/react";
import { directionLabels, sortLabels, taskMethods, type SortChoice } from "./task-sort.ts";

export function SortMenu({
  choice,
  onChange,
}: {
  choice: SortChoice;
  onChange(choice: SortChoice): void;
}) {
  const { method, reverse } = choice;
  return (
    <Dropdown>
      <Button size="sm" variant="tertiary">
        排序 · {sortLabels[method]}
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="排序">
          <Dropdown.Section
            aria-label="排序方式"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[method]}
          >
            {taskMethods.map((key) => (
              <Dropdown.Item
                key={key}
                id={key}
                textValue={sortLabels[key]}
                onAction={() => {
                  if (key !== method) onChange({ method: key, reverse: false });
                }}
              >
                <Label>{sortLabels[key]}</Label>
                <Dropdown.ItemIndicator />
              </Dropdown.Item>
            ))}
          </Dropdown.Section>
          {method !== "manual" && <Separator />}
          {method !== "manual" && (
            <Dropdown.Section
              aria-label="排序方向"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[reverse ? "reverse" : "forward"]}
            >
              {directionLabels[method].map((label, index) => (
                <Dropdown.Item
                  key={label}
                  id={index ? "reverse" : "forward"}
                  textValue={label}
                  onAction={() => {
                    if (reverse !== Boolean(index)) onChange({ method, reverse: Boolean(index) });
                  }}
                >
                  <Label>{label}</Label>
                  <Dropdown.ItemIndicator />
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
