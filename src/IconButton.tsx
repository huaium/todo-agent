import { Button, Tooltip } from "@heroui/react";
import type { ComponentProps } from "react";

const bell = <path d="M18 10a6 6 0 0 0-12 0c0 5-2 6-2 7h16c0-1-2-2-2-7ZM10 20a2.3 2.3 0 0 0 4 0" />;
const paths = {
  bell,
  bellOn: (
    <>
      {bell}
      <path d="m9.5 10.5 1.7 1.7 3.3-3.4" />
    </>
  ),
  bellOff: (
    <path d="m3 3 18 18M9.6 4.5A6 6 0 0 1 18 10c0 1.4.2 2.6.5 3.5M6.3 7.8A7 7 0 0 0 6 10c0 5-2 6-2 7h13M10 20a2.3 2.3 0 0 0 4 0" />
  ),
  microphone: (
    <>
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
    </>
  ),
  stop: <rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none" />,
  settings: (
    <>
      <path d="m10 3-.5 2.2-1.8 1-2.1-.7-2 3.5 1.6 1.5v2.2L3.6 14.3l2 3.5 2.1-.7 1.8 1 .5 2.3h4l.5-2.3 1.8-1 2.1.7 2-3.5-1.6-1.6v-2.2l1.6-1.5-2-3.5-2.1.7-1.8-1L14 3Z" />
      <circle cx="12" cy="11.7" r="3" />
    </>
  ),
  auto: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  dark: <path d="M20.5 14.5a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z" />,
  filter: <path d="M3 4.5h18l-7 8.3v6.1l-4 2v-8.1Z" />,
  trash: (
    <path d="M3.5 6.5h17m-12 0V4.8c0-.7.6-1.3 1.3-1.3h4.4c.7 0 1.3.6 1.3 1.3v1.7m-10 0 .9 13c.1 1 .8 1.5 1.7 1.5h7.8c.9 0 1.6-.5 1.7-1.5l.9-13M10 10v7m4-7v7" />
  ),
};

type Props = Omit<ComponentProps<typeof Button>, "children" | "isIconOnly"> & {
  icon: keyof typeof paths;
  label: string;
};

export function IconButton({ icon, label, ...props }: Props) {
  return (
    <Tooltip>
      <Button {...props} isIconOnly aria-label={label}>
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {paths[icon]}
        </svg>
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
