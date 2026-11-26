import {
  Button,
  Calendar,
  DateField,
  DatePicker,
  FieldError,
  Label,
  TimeField,
} from "@heroui/react";
import { parseDate, parseDateTime, parseTime, today } from "@internationalized/date";
import { useRef } from "react";

interface FieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
}

export function PlannerDate({
  label,
  value,
  onChange,
  required,
  autoFocus,
  disabled,
  withTime,
  zone,
}: FieldProps & { withTime?: boolean; zone: string }) {
  const anchor = today(zone);
  return (
    <DatePicker
      value={value ? (withTime ? parseDateTime(value) : parseDate(value)) : null}
      placeholderValue={withTime ? parseDateTime(anchor.toString() + "T09:00") : anchor}
      granularity={withTime ? "minute" : "day"}
      hourCycle={24}
      autoFocus={autoFocus}
      isDisabled={disabled}
      isRequired={required}
      onChange={(next) => onChange(next ? next.toString().slice(0, withTime ? 16 : 10) : "")}
    >
      <Label>{label}</Label>
      <DateField.Group fullWidth>
        <DateField.Input>{(segment) => <DateField.Segment segment={segment} />}</DateField.Input>
        <DateField.Suffix>
          {value && !required && (
            <Button
              slot={null}
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={"清除" + label}
              onPress={() => onChange("")}
            >
              ×
            </Button>
          )}
          <DatePicker.Trigger aria-label={"选择" + label}>
            <DatePicker.TriggerIndicator />
          </DatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <DatePicker.Popover>
        <Calendar aria-label={label}>
          <Calendar.Header>
            <Calendar.YearPickerTrigger>
              <Calendar.YearPickerTriggerHeading />
              <Calendar.YearPickerTriggerIndicator />
            </Calendar.YearPickerTrigger>
            <Calendar.NavButton slot="previous" />
            <Calendar.NavButton slot="next" />
          </Calendar.Header>
          <Calendar.Grid>
            <Calendar.GridHeader>
              {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
            </Calendar.GridHeader>
            <Calendar.GridBody>{(day) => <Calendar.Cell date={day} />}</Calendar.GridBody>
          </Calendar.Grid>
          <Calendar.YearPickerGrid>
            <Calendar.YearPickerGridBody>
              {({ year }) => <Calendar.YearPickerCell year={year} />}
            </Calendar.YearPickerGridBody>
          </Calendar.YearPickerGrid>
        </Calendar>
      </DatePicker.Popover>
      <FieldError />
    </DatePicker>
  );
}

export function PlannerTime({ label, value, onChange, required, disabled }: FieldProps) {
  const group = useRef<HTMLDivElement>(null);
  return (
    <TimeField
      value={value ? parseTime(value) : null}
      isRequired={required}
      isDisabled={disabled}
      hourCycle={24}
      granularity="minute"
      onChange={(next) => onChange(next?.toString().slice(0, 5) ?? "")}
    >
      <Label>{label}</Label>
      {/* Only the inner input participates in automatic segment navigation. */}
      <TimeField.Group ref={group} slot={null} role="presentation" isDisabled={disabled}>
        <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
        {value && !required && (
          <Button
            slot={null}
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={"清除" + label}
            isDisabled={disabled}
            onPress={() => {
              onChange("");
              group.current?.querySelector<HTMLElement>('[data-type="hour"]')?.focus();
            }}
          >
            ×
          </Button>
        )}
      </TimeField.Group>
      <FieldError />
    </TimeField>
  );
}
