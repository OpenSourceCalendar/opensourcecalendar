// An in-memory Google (OAuth + Calendar API), installed with
// `vi.spyOn(globalThis, "fetch").mockImplementation(fake.fetch)`. Plain on purpose: it's test code.
import { sealToken } from "../src/worker/google/crypto";
import type { GEvent } from "../src/worker/google/client";
import { testEnv } from "./helpers";

export const ALL_SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";
export const PRIMARY = "owner@gmail.com";
export const WORK = "work_x@group.calendar.google.com";

type Stored = GEvent & { deleted?: boolean; [k: string]: unknown };

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const apiError = (status: number, reason: string) => json(status, { error: { code: status, message: "x", errors: [{ reason }] } });

export class FakeGoogle {
  calendars = [
    { id: PRIMARY, summary: PRIMARY, primary: true },
    { id: WORK, summary: "Work" },
  ];
  events = new Map<string, Map<string, Stored>>([[PRIMARY, new Map()], [WORK, new Map()]]);
  refreshTokens = new Set(["refresh-1"]);
  accessTokens = new Set<string>();
  grantedScope = ALL_SCOPES;
  pageSize = 2500;
  /** Forced error for any URL containing the key, e.g. { "/events": { status: 500 } }. */
  fail: Record<string, { status: number; reason?: string; network?: boolean }> = {};
  calls: { method: string; url: string; body?: unknown }[] = [];
  private n = 0;

  addEvent(calendarId: string, e: Partial<Stored> & { id: string }) {
    this.events.get(calendarId)!.set(e.id, { status: "confirmed", ...e } as Stored);
  }

  live(calendarId: string): Stored[] {
    return [...(this.events.get(calendarId)?.values() ?? [])].filter((e) => !e.deleted);
  }

  googleCalls() {
    return this.calls.filter((c) => !c.url.includes("oauth2.googleapis.com/token"));
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : undefined;
    this.calls.push({ method, url: url.href, body: raw });
    for (const [part, f] of Object.entries(this.fail)) {
      if (url.href.includes(part)) {
        if (f.network) throw new TypeError("network down");
        return apiError(f.status, f.reason ?? "unknown");
      }
    }

    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      const p = new URLSearchParams(raw);
      const access = `access-${++this.n}`;
      if (p.get("grant_type") === "authorization_code" && p.get("code") === "good-code") {
        this.accessTokens.add(access);
        const idToken = `${b64url("{}")}.${b64url(JSON.stringify({ email: PRIMARY, email_verified: true }))}.sig`;
        return json(200, { access_token: access, expires_in: 3600, refresh_token: "refresh-1", scope: this.grantedScope, id_token: idToken });
      }
      if (p.get("grant_type") === "refresh_token" && this.refreshTokens.has(p.get("refresh_token") ?? "")) {
        this.accessTokens.add(access);
        return json(200, { access_token: access, expires_in: 3600, scope: this.grantedScope });
      }
      return json(400, { error: "invalid_grant" });
    }
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      this.refreshTokens.delete(new URLSearchParams(raw).get("token") ?? "");
      return json(200, {});
    }

    if (url.host !== "www.googleapis.com") throw new Error(`fake google: unexpected ${method} ${url.href}`);
    const auth = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!this.accessTokens.has(auth)) return apiError(401, "authError");
    const path = url.pathname.replace("/calendar/v3", "");

    if (path === "/users/me/calendarList" && method === "GET") return json(200, { items: this.calendars });

    const m = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!m) throw new Error(`fake google: unexpected ${method} ${url.href}`);
    const cal = this.events.get(decodeURIComponent(m[1]));
    if (!cal) return apiError(404, "notFound");
    const eid = m[2];

    if (!eid && method === "GET") {
      const min = Date.parse(url.searchParams.get("timeMin")!);
      const max = Date.parse(url.searchParams.get("timeMax")!);
      const bound = (t?: { dateTime?: string; date?: string }) => Date.parse(t?.dateTime ?? `${t?.date}T00:00:00Z`);
      const hits = [...cal.values()].filter((e) => !e.deleted && bound(e.start) < max && bound(e.end) > min);
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      const page = hits.slice(offset, offset + this.pageSize);
      const next = offset + this.pageSize < hits.length ? String(offset + this.pageSize) : undefined;
      return json(200, { items: page, ...(next && { nextPageToken: next }) });
    }
    if (!eid && method === "POST") {
      const body = JSON.parse(raw!) as Stored;
      if (cal.has(body.id)) return apiError(409, "duplicate");
      cal.set(body.id, body);
      return json(200, body);
    }
    if (eid && method === "PUT") {
      if (!cal.has(eid)) return apiError(404, "notFound");
      const body = JSON.parse(raw!) as Stored;
      cal.set(eid, { ...body, deleted: body.status === "confirmed" ? false : cal.get(eid)!.deleted });
      return json(200, body);
    }
    if (eid && method === "DELETE") {
      const e = cal.get(eid);
      if (!e) return apiError(404, "notFound");
      if (e.deleted) return apiError(410, "deleted");
      e.deleted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`fake google: unexpected ${method} ${url.href}`);
  };
}

export const TEST_KEY = "Sup-0NtMrEdeKvsoT-KgoFcaYvo7wQYpM5igPaPCaeY";

/** The calendar id for an owner made by helpers.newOwner (looked up by slug). */
export async function calendarIdOf(slug: string): Promise<string> {
  const row = await testEnv.DB.prepare("SELECT id FROM calendars WHERE slug = ?").bind(slug).first<{ id: string }>();
  return row!.id;
}

/** Connect a calendar directly in the database, as if the owner had gone through Google's sign-in. */
export async function connectForTest(calendarId: string, opts: { googleCalendarId?: string; status?: "active" | "broken" } = {}) {
  await testEnv.DB.prepare(
    `INSERT OR REPLACE INTO google_connections (calendar_id, google_email, refresh_token_enc, google_calendar_id, google_calendar_name, status, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(calendarId, PRIMARY, await sealToken(TEST_KEY, calendarId, "refresh-1"), opts.googleCalendarId ?? PRIMARY, "Primary", opts.status ?? "active", Date.now()).run();
}
