// Date, time, zone and money formatting. All built on Intl; no date library.

export const visitorZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** YYYY-MM-DD for `ms` as seen in `zone`. */
export function dateInZone(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Add days to a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Add months to a YYYY-MM month. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Weeks of a month as YYYY-MM-DD, with null for days outside it. Weeks start on Sunday. */
export function monthGrid(month: string): (string | null)[][] {
  const first = new Date(`${month}-01T00:00:00Z`);
  const lead = first.getUTCDay();
  const cells: (string | null)[] = Array(lead).fill(null);
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export const monthLabel = (month: string) =>
  new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/** A calendar date (no zone) as words, e.g. "Thursday, November 19". */
export const dateLabel = (date: string, opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }) =>
  new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));

export const weekdayShort = (): string[] =>
  [0, 1, 2, 3, 4, 5, 6].map((i) =>
    new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(Date.UTC(2023, 0, 1 + i)),
  );

export const formatTime = (iso: string, zone: string) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(iso));

/** "Morning" before noon, "Afternoon" until 5 PM, then "Evening", in `zone`. */
export function dayPart(iso: string, zone: string): "Morning" | "Afternoon" | "Evening" {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(new Date(iso)));
  return hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
}

export const formatDate = (iso: string, zone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: zone }).format(
    new Date(iso),
  );

export const shortDate = (iso: string, zone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: zone }).format(new Date(iso));

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export const minutesBetween = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / 60000);

export function formatPrice(cents: number | null, currency: string): string {
  if (!cents) return "Free";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "Pacific Time", falling back to the zone's city name. */
export function zoneLabel(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    if (part && !/^GMT/.test(part)) return part;
  } catch {
    /* unknown zone: fall through */
  }
  return zoneCity(zone);
}

export const zoneCity = (zone: string) => zone.split("/").pop()!.replace(/_/g, " ");

/** "GMT-8" style offset, for the picker. */
export function zoneOffset(zone: string): string {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

export function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

/** Google Calendar "add event" link. */
export function googleCalendarUrl(a: { title: string; start: string; end: string; details: string }): string {
  const fmt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: a.title,
    dates: `${fmt(a.start)}/${fmt(a.end)}`,
    details: a.details,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
