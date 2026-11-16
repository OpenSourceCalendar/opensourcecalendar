// Time helpers for the owner screens. Everything is shown in the business's time zone,
// using the same DST-safe conversions as the server.

import { localToUtc, offsetMinutes } from "../../worker/slots/tz";

/** ISO instant for `minute` minutes after local midnight on `date` in `zone`. */
export const zoneIso = (date: string, minute: number, zone: string) => new Date(localToUtc(date, minute, zone)).toISOString();

/** Minutes after local midnight for an instant, as seen in `zone`. */
export function minuteOfDay(iso: string | number, zone: string): number {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  const local = ms + offsetMinutes(ms, zone) * 60000;
  return Math.floor((((local % 86400000) + 86400000) % 86400000) / 60000);
}

/** "9:30 AM" for minutes after midnight. */
export const minuteLabel = (minute: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(minute * 60000);

/** "9 AM" for an hour of the day. */
export const hourLabel = (hour: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(hour * 3600000);

/** "HH:MM" (for <input type="time">) to minutes after midnight, or null. */
export function parseTime(value: string): number | null {
  const m = /^(\d\d):(\d\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const timeValue = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
