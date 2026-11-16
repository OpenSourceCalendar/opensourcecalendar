import { useEffect, useState } from "react";
import { api, errorText, type SlotSource } from "../api";
import { addDays, addMonths, dateInZone, dateLabel } from "../time";
import { MonthCalendar } from "./MonthCalendar";
import { TimeGrid } from "./TimeGrid";
import { TimeZonePicker } from "./TimeZonePicker";

interface Props {
  source: SlotSource;
  businessZone: string;
  maxDaysAhead: number;
  zone: string;
  onZone: (zone: string) => void;
  date: string | null;
  slot: string | null;
  onDate: (date: string) => void;
  onSlot: (iso: string) => void;
  /** Bump to refetch days and times (e.g. after "that time was just taken"). */
  reloadKey: number;
}

/** Month calendar of open days, then the open times for the picked day. */
export function DateTimePicker({ source, businessZone, maxDaysAhead, zone, onZone, date, slot, onDate, onSlot, reloadKey }: Props) {
  const today = dateInZone(Date.now(), businessZone);
  const firstMonth = today.slice(0, 7);
  const lastMonth = addDays(today, maxDaysAhead).slice(0, 7);
  const [month, setMonth] = useState(date?.slice(0, 7) ?? firstMonth);
  const [days, setDays] = useState<Record<string, Set<string>>>({});
  const [slots, setSlots] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Until the first open day is found we jump ahead past empty months.
  const [seeking, setSeeking] = useState(!date);
  const sourceKey = JSON.stringify(source);
  const cacheKey = `${reloadKey}:${month}`;

  useEffect(() => {
    if (days[cacheKey]) return;
    let live = true;
    setError(null);
    api.days(source, month).then(
      (r) => {
        if (!live) return;
        setDays((d) => ({ ...d, [cacheKey]: new Set(r.days) }));
        if (seeking) {
          if (r.days.length || month >= lastMonth) setSeeking(false);
          else setMonth(addMonths(month, 1));
        }
      },
      (e) => {
        if (!live) return;
        setSeeking(false);
        setError(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [cacheKey, sourceKey]);

  useEffect(() => {
    if (!date) return;
    let live = true;
    setSlots(null);
    api.slots(source, date).then(
      (r) => live && setSlots(r.slots),
      (e) => {
        if (!live) return;
        setSlots([]);
        setError(errorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [date, reloadKey, sourceKey]);

  const open = seeking ? null : (days[cacheKey] ?? null);
  const noneThisMonth = open && open.size === 0;

  return (
    <div className="picker">
      <MonthCalendar
        month={month}
        openDays={open}
        selected={date}
        today={today}
        canPrev={!seeking && month > firstMonth}
        canNext={!seeking && month < lastMonth}
        onMonth={(d) => setMonth(addMonths(month, d))}
        onSelect={onDate}
      />
      {noneThisMonth && <p className="muted center">No open days in this month.</p>}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <TimeZonePicker zone={zone} businessZone={businessZone} onChange={onZone} />
      {date && (
        <section className="times-section" aria-label="Times">
          <h3 className="sub">
            {dateLabel(date)}
            {zone !== businessZone && <span className="muted"> (business's date)</span>}
          </h3>
          <TimeGrid slots={slots} selected={slot} zone={zone} onSelect={onSlot} grouped />
        </section>
      )}
    </div>
  );
}
