import { Hono } from "hono";
import { requireCalendar } from "../auth";
import { appointmentJson, FULL_SELECT, type AppointmentFull } from "../booking/book";
import { addDays, localToUtc, utcToLocalDate, weekdayOf } from "../slots/tz";
import { customerJson, type CustomerRow } from "./customers";
import type { AppEnv } from "../types";

export const dashboard = new Hono<AppEnv>();
dashboard.use("*", requireCalendar);

dashboard.get("/", async (c) => {
  const db = c.env.DB;
  const cal = c.var.calendar;
  const tz = cal.time_zone;
  const today = utcToLocalDate(Date.now(), tz);
  const tomorrow = addDays(today, 1);
  const weekStart = addDays(today, -weekdayOf(today));
  const monthStart = `${today.slice(0, 8)}01`;
  const nextMonth = addDays(`${today.slice(0, 8)}28`, 4).slice(0, 8) + "01"; // 28th + 4 days is always next month
  const at = (date: string) => localToUtc(date, 0, tz);

  const counts = await db.prepare(
    `SELECT
       COALESCE(SUM(start_at >= ?2 AND start_at < ?3), 0) AS today,
       COALESCE(SUM(start_at >= ?4 AND start_at < ?5), 0) AS this_week,
       COALESCE(SUM(start_at >= ?6 AND start_at < ?7), 0) AS this_month
     FROM appointments WHERE calendar_id = ?1 AND status != 'cancelled'`,
  )
    .bind(cal.id, at(today), at(tomorrow), at(weekStart), at(addDays(weekStart, 7)), at(monthStart), at(nextMonth))
    .first<{ today: number; this_week: number; this_month: number }>();
  const total = await db.prepare("SELECT COUNT(*) AS n FROM customers WHERE calendar_id = ? AND deleted_at IS NULL").bind(cal.id).first<{ n: number }>();
  const { results: todays } = await db.prepare(
    `${FULL_SELECT} WHERE a.calendar_id = ? AND a.status != 'cancelled' AND a.start_at >= ? AND a.start_at < ? ORDER BY a.start_at LIMIT 200`,
  )
    .bind(cal.id, at(today), at(tomorrow))
    .all<AppointmentFull>();
  const { results: recent } = await db.prepare(
    "SELECT * FROM customers WHERE calendar_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 5",
  )
    .bind(cal.id)
    .all<CustomerRow>();

  return c.json({
    today: counts?.today ?? 0,
    this_week: counts?.this_week ?? 0,
    this_month: counts?.this_month ?? 0,
    customers: total?.n ?? 0,
    today_appointments: todays.map(appointmentJson),
    recent_customers: recent.map(customerJson),
  });
});
