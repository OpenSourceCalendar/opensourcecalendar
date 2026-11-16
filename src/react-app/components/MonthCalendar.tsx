import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { addDays, dateLabel, monthGrid, monthLabel, weekdayShort } from "../time";

interface Props {
  month: string;
  /** Open days in this month, or null while loading. */
  openDays: Set<string> | null;
  selected: string | null;
  today: string;
  canPrev: boolean;
  canNext: boolean;
  onMonth: (delta: number) => void;
  onSelect: (date: string) => void;
}

/** Month grid. Arrow keys move between days (roving tab stop); Enter or Space picks. */
export function MonthCalendar({ month, openDays, selected, today, canPrev, canNext, onMonth, onSelect }: Props) {
  const weeks = monthGrid(month);
  const days = weeks.flat().filter((d): d is string => !!d);
  const firstOpen = days.find((d) => openDays?.has(d));
  const [focus, setFocus] = useState<string | null>(null);
  const tabStop = focus && focus.startsWith(month) ? focus : selected?.startsWith(month) ? selected : (firstOpen ?? days[0]);
  const gridRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${tabStop}"]`)?.focus();
  }, [tabStop]);

  function onKey(e: KeyboardEvent, date: string) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = addDays(date, step);
    if (!next.startsWith(month)) {
      const delta = next < month ? -1 : 1;
      if (delta < 0 ? !canPrev : !canNext) return;
      onMonth(delta);
    }
    moved.current = true;
    setFocus(next);
  }

  const names = weekdayShort();
  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="icon-btn" onClick={() => onMonth(-1)} disabled={!canPrev} aria-label="Previous month">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <h3 className="cal-title" aria-live="polite">{monthLabel(month)}</h3>
        <button type="button" className="icon-btn" onClick={() => onMonth(1)} disabled={!canNext} aria-label="Next month">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <div className="cal-grid" role="grid" aria-label={monthLabel(month)} ref={gridRef} aria-busy={!openDays}>
        <div role="row" className="cal-row">
          {names.map((n) => (
            <span role="columnheader" className="cal-dow" key={n} aria-label={n}>
              {n.slice(0, 2)}
            </span>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div role="row" className="cal-row" key={wi}>
            {week.map((d, di) =>
              d ? (
                <span role="gridcell" key={d}>
                  <button
                    type="button"
                    data-date={d}
                    className={`cal-day${d === today ? " today" : ""}${openDays === null ? " loading" : ""}`}
                    tabIndex={d === tabStop ? 0 : -1}
                    aria-disabled={!openDays?.has(d)}
                    aria-pressed={d === selected}
                    aria-label={`${dateLabel(d)}${openDays?.has(d) ? "" : ", no open times"}`}
                    onClick={() => openDays?.has(d) && onSelect(d)}
                    onKeyDown={(e) => onKey(e, d)}
                    onFocus={() => setFocus(d)}
                  >
                    {Number(d.slice(8))}
                  </button>
                </span>
              ) : (
                <span role="gridcell" key={`x${di}`} />
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
