import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api";
import { allZones, dateInZone, dateLabel, zoneLabel, zoneOffset } from "../time";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText, type BlockedDates, type Break, type Override, type Rules, type WeeklyDay } from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
import { SaveBar } from "./SaveBar";
import { Setting, Switch } from "./Switch";
import { minuteLabel, parseTime, timeValue } from "./zone";

const DAY_NAMES = [0, 1, 2, 3, 4, 5, 6].map((i) =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + i)),
);
type Tab = "hours" | "off" | "rules";
const TABS: [Tab, string][] = [["hours", "Weekly hours"], ["off", "Days off"], ["rules", "Booking rules"]];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What's wrong with a day's hours, or "" if they're fine. */
function hoursProblem(d: { start_min: number; end_min: number; breaks: Break[] }): string {
  if (d.start_min >= d.end_min) return "The end time must be after the start time.";
  for (const b of d.breaks) {
    if (b.start_min >= b.end_min) return "A break must end after it starts.";
    if (b.start_min < d.start_min || b.end_min > d.end_min) return "Breaks must be inside the open hours.";
  }
  return "";
}

function TimeField({ label, value, onChange }: { label: string; value: number; onChange: (minute: number) => void }) {
  return (
    <input
      className="input time-input"
      type="time"
      step={300}
      aria-label={label}
      value={timeValue(Math.min(value, 1439))}
      onChange={(e) => {
        const m = parseTime(e.target.value);
        if (m !== null) onChange(m);
      }}
    />
  );
}

/** Open hours for one day: start, end and breaks. Used for weekly rows and one-day changes. */
function HoursEditor({
  name,
  hours,
  onChange,
  extra,
}: {
  name: string;
  hours: { start_min: number; end_min: number; breaks: Break[] };
  onChange: (patch: { start_min?: number; end_min?: number; breaks?: Break[] }) => void;
  /** Extra actions at the end of the hours line. */
  extra?: ReactNode;
}) {
  const setBreak = (i: number, patch: Partial<Break>) => onChange({ breaks: hours.breaks.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  return (
    <div className="hours">
      <div className="hours-line">
        <TimeField label={`${name} opens`} value={hours.start_min} onChange={(m) => onChange({ start_min: m })} />
        <span className="muted" aria-hidden="true">
          –
        </span>
        <TimeField label={`${name} closes`} value={hours.end_min} onChange={(m) => onChange({ end_min: m })} />
        {hours.breaks.length < 10 && (
          <button
            type="button"
            className="link hours-action"
            aria-label={`Add a break on ${name}`}
            onClick={() => {
              // Start with an hour in the middle of the day.
              const mid = Math.round((hours.start_min + hours.end_min) / 2 / 30) * 30;
              onChange({ breaks: [...hours.breaks, { start_min: mid, end_min: Math.min(mid + 60, hours.end_min) }] });
            }}
          >
            + Break
          </button>
        )}
        {extra}
      </div>
      {hours.breaks.map((b, i) => (
        <div className="hours-line hours-break" key={i}>
          <span className="hours-break-label">Break</span>
          <TimeField label={`${name} break ${i + 1} starts`} value={b.start_min} onChange={(m) => setBreak(i, { start_min: m })} />
          <span className="muted" aria-hidden="true">
            –
          </span>
          <TimeField label={`${name} break ${i + 1} ends`} value={b.end_min} onChange={(m) => setBreak(i, { end_min: m })} />
          <button type="button" className="icon-btn icon-sm" aria-label={`Remove ${name} break ${i + 1}`} onClick={() => onChange({ breaks: hours.breaks.filter((_, j) => j !== i) })}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

const NOTICE: [number, string][] = [[0, "No minimum"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [720, "12 hours"], [1440, "1 day"], [2880, "2 days"]];
const CUTOFF: [number, string][] = [[0, "Any time"], [1, "1 hour before"], [2, "2 hours before"], [4, "4 hours before"], [12, "12 hours before"], [24, "24 hours before"], [48, "48 hours before"]];
const STEPS: [number, string][] = [[15, "15 minutes"], [30, "30 minutes"], [60, "hour"]];
/** Keep a stored value that isn't one of the usual choices. */
const withCurrent = (options: [number, string][], value: number, unit: string): [number, string][] =>
  options.some(([v]) => v === value) ? options : [...options, [value, `${value} ${unit}`]];

// powered_by is on Branding and block_all_day_google on the Google page; this form leaves them alone.
type RuleForm = Omit<Rules, "powered_by" | "block_all_day_google">;
const ruleForm = (r: Rules): RuleForm => ({
  buffer_min: r.buffer_min,
  max_per_day: r.max_per_day,
  min_notice_min: r.min_notice_min,
  max_days_ahead: r.max_days_ahead,
  change_cutoff_hours: r.change_cutoff_hours,
  slot_step_min: r.slot_step_min,
  required_fields: r.required_fields,
  cancel_reason_required: r.cancel_reason_required,
});

export function Availability({ calendar, notify, setDirty, onCalendar }: PageProps) {
  const zone = calendar.time_zone;
  const today = dateInZone(Date.now(), zone);
  const [saved, setSaved] = useState<WeeklyDay[] | null>(null);
  const [days, setDays] = useState<WeeklyDay[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [blocked, setBlocked] = useState<BlockedDates[]>([]);
  const [rules, setRules] = useState<RuleForm>(() => ruleForm(calendar.rules));
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("hours");
  const [changes, setChanges] = useState(0);
  const loaded = useRef(false);

  useEffect(() => {
    let live = true;
    adminApi.availability().then(
      (a) => {
        if (!live) return;
        // Only fill the weekly rows on the first load, so later reloads don't wipe unsaved edits.
        if (!loaded.current) {
          loaded.current = true;
          setSaved(a.weekly);
          setDays(a.weekly);
        }
        setOverrides(a.overrides);
        setBlocked(a.blocked_dates);
        setLoadError("");
      },
      (e) => live && setLoadError(adminErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [changes]);

  const weeklyDirty = !!saved && !same(days, saved);
  const rulesDirty = !same(rules, ruleForm(calendar.rules));
  const dirty = weeklyDirty || rulesDirty;
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);

  const dayProblems = days.map((d) => (d.open ? hoursProblem(d) : ""));
  const fields = rules.required_fields;
  const blockedReason = dayProblems.some(Boolean)
    ? "Fix the hours marked above."
    : !fields.phone && !fields.email
      ? "Ask for a phone or an email so you can reach them."
      : !(Number.isInteger(rules.max_days_ahead) && rules.max_days_ahead >= 1 && rules.max_days_ahead <= 730)
        ? "How far ahead must be a whole number of days, 1 to 730."
        : rules.max_per_day !== null && !(Number.isInteger(rules.max_per_day) && rules.max_per_day >= 1 && rules.max_per_day <= 200)
          ? "Maximum bookings per day must be a whole number, 1 to 200, or empty."
          : "";

  const setDay = (weekday: number, patch: Partial<WeeklyDay>) => setDays((all) => all.map((d) => (d.weekday === weekday ? { ...d, ...patch } : d)));
  const setRule = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setRules((r) => ({ ...r, [key]: value }));

  async function save() {
    if (saving || blockedReason) return;
    setSaving(true);
    setSaveError("");
    try {
      // Each part that saves becomes clean, so a failure in the second leaves only that one unsaved.
      if (weeklyDirty) {
        // A closed day's breaks aren't kept by the server, but it still checks them: don't send any.
        const a = await adminApi.saveWeekly(days.map((d) => (d.open ? d : { ...d, breaks: [] })));
        setSaved(a.weekly);
        setDays(a.weekly);
      }
      if (rulesDirty) {
        const next = await adminApi.updateCalendar({ rules });
        onCalendar(next);
        setRules(ruleForm(next.rules));
      }
      notify({ text: "Saved" });
    } catch (e) {
      setSaveError(
        e instanceof ApiError && e.error === "invalid_input" ? "Something in the hours or rules isn't right. Check them and try again." : adminErrorText(e),
      );
    }
    setSaving(false);
  }

  function discard() {
    if (saved) setDays(saved);
    setRules(ruleForm(calendar.rules));
    setSaveError("");
  }

  const reload = () => setChanges((n) => n + 1);
  async function act(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      notify({ text: done });
    } catch (e) {
      notify({ text: adminErrorText(e), error: true });
    }
    reload();
  }

  const openCount = days.filter((d) => d.open).length;

  return (
    <>
      <header className="admin-band">
        <h1 className="admin-title">Availability</h1>
        <p className="muted">When people can book you.</p>
      </header>
      {loadError && (
        <p className="alert" role="alert">
          {loadError}
        </p>
      )}

      <div className="segmented tabs" role="tablist" aria-label="Availability">
        {TABS.map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
            {label}
            {/* A dot on a tab with unsaved changes, so they aren't forgotten behind another tab. */}
            {((value === "hours" && weeklyDirty) || (value === "rules" && rulesDirty)) && <span className="tab-dot" aria-label="unsaved changes" />}
          </button>
        ))}
      </div>

      {tab === "hours" && (
        <section className="card" aria-label="Weekly hours">
          <p className="muted small">
            Your usual week, in <strong>{zoneLabel(zone)}</strong>.{" "}
            <button type="button" className="link" onClick={() => setZoneOpen(true)}>
              Change time zone
            </button>
          </p>
          {!saved ? (
            <span className="skeleton block" />
          ) : (
            <ul className="week">
              {days.map((d, i) => (
                <li key={d.weekday} className={d.open ? "week-row" : "week-row is-closed"}>
                  <Switch checked={d.open} label={`Open on ${DAY_NAMES[d.weekday]}`} onChange={(open) => setDay(d.weekday, { open })} />
                  <span className="week-day">{DAY_NAMES[d.weekday]}</span>
                  {d.open ? (
                    <div className="week-hours">
                      <HoursEditor
                        name={DAY_NAMES[d.weekday]}
                        hours={d}
                        onChange={(patch) => setDay(d.weekday, patch)}
                        extra={
                          openCount > 1 && (
                            <button
                              type="button"
                              className="icon-btn icon-sm"
                              title="Copy these hours to every open day"
                              aria-label={`Copy ${DAY_NAMES[d.weekday]}'s hours to every open day`}
                              onClick={() => setDays((all) => all.map((x) => (x.open ? { ...x, start_min: d.start_min, end_min: d.end_min, breaks: d.breaks } : x)))}
                            >
                              <Icon name="copy" size={18} />
                            </button>
                          )
                        }
                      />
                      {dayProblems[i] && (
                        <p className="field-error" role="alert">
                          {dayProblems[i]}
                        </p>
                      )}
                    </div>
                  ) : (
                    <span className="muted">Closed</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "off" && (
        <>
          <section className="card" aria-label="Block dates">
            <BlockForm today={today} onBlock={(input) => act(() => adminApi.blockDates(input), "Dates blocked")} />
            {blocked.length > 0 && (
              <ul className="rows">
                {blocked.map((b) => (
                  <li key={b.id} className="row">
                    <span className="row-main">
                      <strong>{b.label || "Blocked"}</strong>
                      <span className="muted small">
                        {b.start_date === b.end_date ? dateLabel(b.start_date) : `${dateLabel(b.start_date)} to ${dateLabel(b.end_date)}`}
                      </span>
                    </span>
                    <button type="button" className="link muted" onClick={() => act(() => adminApi.unblockDates(b.id), "Block removed")}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Change hours for one day">
            <OverrideForm today={today} onSave={(date, input) => act(() => adminApi.putOverride(date, input), "Hours changed for that day")} />
            {overrides.length > 0 && (
              <ul className="rows">
                {overrides.map((o) => (
                  <li key={o.on_date} className="row">
                    <span className="row-main">
                      <strong>{dateLabel(o.on_date)}</strong>
                      <span className="muted small">
                        {o.closed || o.start_min === null || o.end_min === null ? "Closed" : `${minuteLabel(o.start_min)} to ${minuteLabel(o.end_min)}`}
                        {!o.closed && o.breaks.length > 0 && ` · ${o.breaks.length} ${o.breaks.length === 1 ? "break" : "breaks"}`}
                      </span>
                    </span>
                    <button type="button" className="link muted" onClick={() => act(() => adminApi.deleteOverride(o.on_date), "Back to the usual hours")}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {tab === "rules" && (
        <section className="card settings" aria-label="Booking rules">
          <Setting title="Buffer time between appointments" help="Padding after each booking ends.">
            <div className="segmented" role="group" aria-label="Buffer time">
              {([0, 15, 30] as const).map((m) => (
                <button key={m} type="button" aria-pressed={rules.buffer_min === m} onClick={() => setRule("buffer_min", m)}>
                  {m ? `${m} min` : "None"}
                </button>
              ))}
            </div>
          </Setting>
          <Setting title="Maximum bookings per day" help="Leave empty for no limit.">
            <input
              className="input num-input"
              type="number"
              min={1}
              max={200}
              aria-label="Maximum bookings per day"
              placeholder="No limit"
              value={rules.max_per_day ?? ""}
              onChange={(e) => setRule("max_per_day", e.target.value === "" ? null : Number(e.target.value))}
            />
          </Setting>
          <Setting title="Minimum notice" help="How soon before an appointment someone can still book it.">
            <select className="input" aria-label="Minimum notice" value={rules.min_notice_min} onChange={(e) => setRule("min_notice_min", Number(e.target.value))}>
              {withCurrent(NOTICE, rules.min_notice_min, "minutes").map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Setting>
          <Setting title="How far ahead people can book" help="In days from today.">
            <input className="input num-input" type="number" min={1} max={730} aria-label="How far ahead, in days" value={rules.max_days_ahead || ""} onChange={(e) => setRule("max_days_ahead", Number(e.target.value))} />
          </Setting>
          <Setting title="Changes and cancellations" help="How late a customer can move or cancel their own booking.">
            <select className="input" aria-label="Changes and cancellations" value={rules.change_cutoff_hours} onChange={(e) => setRule("change_cutoff_hours", Number(e.target.value))}>
              {withCurrent(CUTOFF, rules.change_cutoff_hours, "hours before").map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Setting>
          <Setting title="Start times" help="How often a new start time is offered, e.g. 9:00, 9:15, 9:30.">
            <select className="input" aria-label="Start times" value={rules.slot_step_min} onChange={(e) => setRule("slot_step_min", Number(e.target.value))}>
              {withCurrent(STEPS, rules.slot_step_min, "minutes").map(([v, l]) => (
                <option key={v} value={v}>
                  Every {l}
                </option>
              ))}
            </select>
          </Setting>
          {(["last_name", "phone", "email"] as const).map((f) => {
            const name = { last_name: "last name", phone: "phone number", email: "email" }[f];
            return (
              <Setting key={f} title={`Ask for ${name}`} help={f === "last_name" ? "First name is always asked for." : `Customers must give ${f === "email" ? "an email" : "a phone number"} to book.`}>
                <Switch checked={fields[f]} label={`Require ${name}`} onChange={(on) => setRule("required_fields", { ...fields, first_name: true, [f]: on })} />
              </Setting>
            );
          })}
          {!fields.phone && !fields.email && (
            <p className="field-error" role="alert">
              Ask for a phone or an email so you can reach them.
            </p>
          )}
          <Setting title="Ask why when a customer cancels" help="They must give a reason to cancel online.">
            <Switch checked={rules.cancel_reason_required} label="Ask for a reason when a customer cancels" onChange={(on) => setRule("cancel_reason_required", on)} />
          </Setting>
        </section>
      )}

      {/* Days off saves as you go, so the bar only shows there if another tab has unsaved changes. */}
      {(tab !== "off" || dirty) && <SaveBar dirty={dirty} saving={saving} error={saveError} blocked={blockedReason} onSave={save} onDiscard={discard} />}

      {zoneOpen && (
        <ZoneDialog
          zone={zone}
          onClose={() => setZoneOpen(false)}
          onSaved={(next) => {
            setZoneOpen(false);
            onCalendar(next);
            notify({ text: `Time zone changed to ${zoneLabel(next.time_zone)}` });
          }}
        />
      )}
    </>
  );
}

function BlockForm({ today, onBlock }: { today: string; onBlock: (input: { start_date: string; end_date: string; label: string }) => void }) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [label, setLabel] = useState("");
  const last = end || start;
  const ok = !!start && start <= last;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return;
    onBlock({ start_date: start, end_date: last, label: label.trim() });
    setStart("");
    setEnd("");
    setLabel("");
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <h2 className="card-title">Block dates</h2>
      <p className="muted small">For vacations and holidays. Nobody can book on these days.</p>
      <div className="inline-fields">
        <div className="field">
          <label className="label" htmlFor="bl-start">
            From
          </label>
          <input id="bl-start" className="input" type="date" min={today} value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="bl-end">
            To <span className="opt">(optional)</span>
          </label>
          <input id="bl-end" className="input" type="date" min={start || today} value={end} aria-invalid={!!end && end < start} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="bl-label">
            Label <span className="opt">(optional)</span>
          </label>
          <input id="bl-label" className="input" maxLength={100} placeholder="Thanksgiving" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-secondary btn-auto" disabled={!ok}>
          Block these dates
        </button>
      </div>
    </form>
  );
}

function OverrideForm({
  today,
  onSave,
}: {
  today: string;
  onSave: (date: string, input: { closed: boolean; start_min?: number; end_min?: number; breaks?: Break[] }) => void;
}) {
  const [date, setDate] = useState("");
  const [closed, setClosed] = useState(false);
  const [hours, setHours] = useState({ start_min: 540, end_min: 720, breaks: [] as Break[] });
  const problem = closed ? "" : hoursProblem(hours);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!date || problem) return;
    onSave(date, closed ? { closed: true } : { closed: false, ...hours });
    setDate("");
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <h2 className="card-title">Change hours for one day</h2>
      <p className="muted small">Open a day you're normally closed, or close early. Your weekly hours stay the same.</p>
      <div className="inline-fields">
        <div className="field">
          <label className="label" htmlFor="ov-date">
            Date
          </label>
          <input id="ov-date" className="input" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <label className="check-row">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
          Closed that day
        </label>
      </div>
      {!closed && <HoursEditor name="That day" hours={hours} onChange={(patch) => setHours((h) => ({ ...h, ...patch }))} />}
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <button type="submit" className="btn btn-secondary btn-auto" disabled={!date || !!problem}>
        Save this day
      </button>
    </form>
  );
}

function ZoneDialog({ zone, onClose, onSaved }: { zone: string; onClose: () => void; onSaved: (calendar: PageProps["calendar"]) => void }) {
  const [next, setNext] = useState(zone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const zones = useMemo(() => {
    const all = allZones();
    return (all.includes(zone) ? all : [zone, ...all]).map((z) => ({ value: z, label: `${z.replace(/_/g, " ")} (${zoneOffset(z)})` }));
  }, [zone]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      onSaved(await adminApi.updateCalendar({ time_zone: next }));
    } catch (e) {
      setError(adminErrorText(e));
      setBusy(false);
    }
  }

  return (
    <Dialog kind="modal" title="Change time zone" onClose={onClose}>
      <div className="field">
        <label className="label" htmlFor="tz-select">
          Time zone
        </label>
        <select id="tz-select" className="input" value={next} onChange={(e) => setNext(e.target.value)}>
          {zones.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
      </div>
      {next !== zone && (
        <p className="info">
          Your open hours will mean {zoneLabel(next)} times. Appointments already booked keep their real moment, so they will show at a
          different clock time.
        </p>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="two">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || next === zone} onClick={save}>
          {busy ? "Changing…" : "Change time zone"}
        </button>
      </div>
    </Dialog>
  );
}
