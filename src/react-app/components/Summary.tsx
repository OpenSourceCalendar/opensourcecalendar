import type { ReactNode } from "react";

const ICONS = {
  service: <path d="M4 7h16M4 12h10M4 17h7" />,
  date: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  time: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </>
  ),
};

export type SummaryRow = { icon: keyof typeof ICONS; label: string; value: ReactNode };

/** Labelled rows (service, date, time…) used on the info step, the confirmed screen and the manage page. */
export function Summary({ rows }: { rows: SummaryRow[] }) {
  return (
    <dl className="summary">
      {rows.map((r) => (
        <div className="summary-row" key={r.label}>
          <svg className="summary-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              {ICONS[r.icon]}
            </g>
          </svg>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
