import { Hono } from "hono";
import { adminLogin, createAdminSession, requireApp, requireSession, setup } from "./auth";
import { appointments } from "./routes/appointments";
import { availability } from "./routes/availability";
import { customers } from "./routes/customers";
import { dashboard } from "./routes/dashboard";
import { images } from "./routes/images";
import { publicRoutes } from "./routes/public";
import { reminders } from "./routes/reminders";
import { calendar } from "./routes/calendar";
import { slots } from "./routes/slots";
import { services } from "./routes/services";
import { google, googleCallback, googleConfirm } from "./routes/google";
import { webhook } from "./routes/webhook";
import { site } from "./site/routes";
import { runWebhookJobs } from "./webhooks/outbox";
import { runDueJobs } from "./email/outbox";
import { sendWith } from "./email/send";
import { runGoogleSync } from "./google/busy";
import { runGoogleJobs } from "./google/push";
import type { AppEnv, Bindings } from "./types";

const app = new Hono<AppEnv>();

// www.opensourcecalendar.com → opensourcecalendar.com, so there's one address for search engines.
app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (!url.hostname.startsWith("www.")) return next();
  url.hostname = url.hostname.slice(4);
  return c.redirect(url.toString(), 301);
});

app.get("/health", (c) => c.json({ ok: true }));
// Home, privacy and terms pages, and the waitlist form (site/).
app.route("/", site);
app.route("/api/setup", setup);

app.route("/api/public", publicRoutes);
// Google's sign-in tab lands here; no session (see routes/google.ts).
app.get("/api/google/callback", googleCallback);
app.post("/api/google/confirm", googleConfirm);

function mountApi(r: Hono<AppEnv>) {
  r.route("/calendar", calendar);
  r.route("/services", services);
  r.route("/availability", availability);
  r.route("/slots", slots);
  r.route("/customers", customers);
  r.route("/appointments", appointments);
  r.route("/reminders", reminders);
  r.route("/dashboard", dashboard);
  r.route("/images", images);
  r.route("/google", google);
}

const v1 = new Hono<AppEnv>();
v1.use("*", requireApp);
v1.post("/admin-sessions", createAdminSession);
mountApi(v1);
// The host app's own settings: API key only, so not in mountApi (owner screens can't reach it).
v1.route("/webhook", webhook);
app.route("/api/v1", v1);

app.route("/api/admin", adminLogin); // /api/admin/login, no session needed
const admin = new Hono<AppEnv>();
admin.use("*", requireSession);
mountApi(admin);
app.route("/api/admin", admin);

export { app };

export default {
  fetch: app.fetch,
  /** Every minute: send due emails (retries and reminders), clear out old finished jobs, copy bookings to Google and Google's busy times in, deliver webhooks. */
  async scheduled(_event: ScheduledController, env: Bindings, ctx: ExecutionContext) {
    const now = Date.now();
    const log = (what: string) => (err: unknown) => console.error(JSON.stringify({ event: `${what}_failed`, error: String(err).slice(0, 200) }));
    ctx.waitUntil(runDueJobs(env, now, sendWith(env), { cleanUp: true }));
    ctx.waitUntil(runGoogleJobs(env, now).catch(log("google_run")));
    ctx.waitUntil(runGoogleSync(env, now).catch(log("google_sync")));
    ctx.waitUntil(runWebhookJobs(env, now).catch(log("webhook_run")));
  },
};
