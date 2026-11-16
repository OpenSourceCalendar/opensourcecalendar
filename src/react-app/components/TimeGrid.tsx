import { useId } from "react";
import { dayPart, formatTime } from "../time";

type Props = { slots: string[] | null; selected: string | null; zone: string; onSelect: (iso: string) => void; /** Split into morning / afternoon / evening. */ grouped?: boolean };

/** Open times as buttons, optionally grouped by part of the day. `slots` is null while loading. */
export function TimeGrid({ slots, selected, zone, onSelect, grouped = false }: Props) {
  const uid = useId();
  if (slots === null) {
    return (
      <div className="times" aria-busy="true" aria-label="Loading times">
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} className="skeleton time-skeleton" />
        ))}
      </div>
    );
  }
  if (!slots.length) return <p className="muted">No open times left on this day. Please pick another day.</p>;
  const button = (s: string) => (
    <button key={s} type="button" className="time" aria-pressed={s === selected} onClick={() => onSelect(s)}>
      {formatTime(s, zone)}
    </button>
  );
  if (!grouped) {
    return (
      <div className="times" role="group" aria-label="Available times">
        {slots.map(button)}
      </div>
    );
  }
  // Walk the times in order and start a group whenever the part of day changes, so a day that
  // wraps past midnight in the visitor's zone stays in time order (a label may then repeat).
  const groups: { part: string; slots: string[] }[] = [];
  for (const s of slots) {
    const part = dayPart(s, zone);
    if (groups.at(-1)?.part === part) groups.at(-1)!.slots.push(s);
    else groups.push({ part, slots: [s] });
  }
  return (
    <div className="time-parts">
      {groups.map((g, i) => {
        const id = `${uid}-${i}`;
        return (
          <div key={i} className="time-part">
            <p className="time-part-label" id={id}>
              {g.part}
            </p>
            <div className="times" role="group" aria-labelledby={id}>
              {g.slots.map(button)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
