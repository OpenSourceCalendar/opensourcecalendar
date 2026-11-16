import { Hono } from "hono";
import { requireCalendar } from "../auth";
import { isDate, notFound } from "../lib/http";
import { findSlots } from "../slots/find-slots";
import { loadSlotInput } from "../slots/load";
import { getService } from "./services";
import type { AppEnv } from "../types";

export const slots = new Hono<AppEnv>();
slots.use("*", requireCalendar);

slots.get("/", async (c) => {
  const date = c.req.query("date") ?? "";
  const serviceId = c.req.query("service_id") ?? "";
  if (!isDate(date) || !serviceId) return c.json({ error: "invalid_input" }, 400);
  const cal = c.var.calendar;
  const service = await getService(c.env.DB, cal.id, serviceId);
  if (!service) return notFound(c);
  const input = await loadSlotInput(c.env.DB, cal, service, date, Date.now());
  return c.json({ date, time_zone: cal.time_zone, slots: findSlots(input).map((t) => new Date(t).toISOString()) });
});
