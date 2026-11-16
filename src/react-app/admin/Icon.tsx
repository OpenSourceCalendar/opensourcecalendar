const PATHS = {
  dashboard: "M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z",
  schedule: "M4 5h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 9h14M7 3v4M13 3v4",
  services: "M4 6h12M4 10h12M4 14h8",
  availability: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 6v4l3 2",
  customers:
    "M7.5 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 17c0-3 2.5-5 5.5-5s5.5 2 5.5 5M14 9a2.5 2.5 0 1 0 0-5M15 12c2 .5 3 2.2 3 4.5",
  google: "M4 10a6 6 0 0 1 10.5-4L16 7.5M16 4v3.5h-3.5M16 10a6 6 0 0 1-10.5 4L4 12.5M4 16v-3.5h3.5",
  branding: "M10 3s5 5 5 8.5a5 5 0 0 1-10 0C5 8 10 3 10 3z",
  share:
    "M6 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7.8 9.1l4.4-2.2M7.8 10.9l4.4 2.2",
  menu: "M3 6h14M3 10h14M3 14h14",
  plus: "M10 4v12M4 10h12",
  close: "M5 5l10 10M15 5L5 15",
  copy: "M8 7h8v9H8zM5 13V4h8",
  bell: "M5 14V9a5 5 0 0 1 10 0v5l1.5 2h-13L5 14zM8.5 18a1.5 1.5 0 0 0 3 0",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
