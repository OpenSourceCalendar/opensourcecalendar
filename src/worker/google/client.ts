// All calls to Google: plain fetch, no SDK. Every call has a timeout, and failures become GoogleError
// with Google's short reason code (never its message text, which can contain addresses).
import { fromBase64Url } from "../lib/session";
import type { Bindings } from "../types";

export const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const SCOPES = ["openid", "email", EVENTS_SCOPE, LIST_SCOPE];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleError extends Error {
  constructor(public status: number, public reason: string) {
    super(`google ${status} ${reason}`);
  }
}

export const errorCode = (err: unknown) => (err instanceof GoogleError ? `${err.status}_${err.reason}` : "error");

export type GoogleConfig = { clientId: string; clientSecret: string; tokenKey: string };

/** Null when this install hasn't set up Google (all three secrets are needed). */
export function googleConfig(env: Bindings): GoogleConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_TOKEN_KEY) return null;
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, tokenKey: env.GOOGLE_TOKEN_KEY };
}

/** Must match the "Authorized redirect URI" in Google Cloud exactly. */
export function redirectUri(env: Bindings, requestOrigin: string): string {
  return `${(env.PUBLIC_URL || requestOrigin).replace(/\/+$/, "")}/api/google/callback`;
}

export function authUrl(cfg: GoogleConfig, redirect: string, state: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `${AUTH_URL}?${p}`;
}

/** Google sign-in for our own log-in page: identity only, no Calendar scopes, no offline access. */
export function signInUrl(cfg: GoogleConfig, redirect: string, state: string): string {
  const p = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirect, response_type: "code", scope: "openid email", prompt: "select_account", state });
  return `${AUTH_URL}?${p}`;
}

function reasonOf(body: unknown): string {
  const b = body as { error?: unknown } | null;
  if (typeof b?.error === "string") return b.error; // token endpoint: { error: "invalid_grant" }
  const e = b?.error as { errors?: { reason?: string }[]; status?: string } | undefined;
  return e?.errors?.[0]?.reason ?? e?.status ?? "unknown";
}

const DEFAULT_TIMEOUT = 10_000;

async function send(url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new GoogleError(0, "network"); // timeout or connection failure
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON (an HTML error page); keep null
  }
  if (!res.ok) throw new GoogleError(res.status, reasonOf(body));
  return body;
}

function api(access: string, path: string, opts: { method?: string; json?: unknown; timeoutMs?: number } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${access}` };
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  return send(`${API}${path}`, { method: opts.method ?? "GET", headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json) }, opts.timeoutMs);
}

export type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };

const tokenCall = (params: Record<string, string>, timeoutMs?: number): Promise<TokenResponse> =>
  send(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }, timeoutMs);

export const exchangeCode = (cfg: GoogleConfig, code: string, redirect: string) =>
  tokenCall({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: cfg.clientId, client_secret: cfg.clientSecret });

export const refreshAccess = (cfg: GoogleConfig, refreshToken: string, timeoutMs?: number) =>
  tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret }, timeoutMs);

/** Best effort: the connection is removed on our side either way. */
export async function revokeToken(token: string): Promise<void> {
  await send(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }).catch(() => {});
}

/**
 * The signed-in address from the id_token. Its signature isn't checked: it came straight from Google's
 * token endpoint over TLS (Google's docs allow this), and it's only shown to the owner, never trusted for access.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  const part = idToken?.split(".")[1];
  const raw = part ? fromBase64Url(part) : null;
  if (!raw) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(raw)) as { email?: unknown; email_verified?: unknown };
    return typeof c.email === "string" && c.email_verified !== false ? c.email : null;
  } catch {
    return null;
  }
}

export type GCalendar = { id: string; summary?: string; summaryOverride?: string; primary?: boolean };

/** Calendars the owner can add events to. */
export async function listCalendars(access: string): Promise<GCalendar[]> {
  const body = await api(access, "/users/me/calendarList?minAccessRole=writer&maxResults=250&fields=items(id,summary,summaryOverride,primary)");
  return (body?.items ?? []) as GCalendar[];
}

export const calendarName = (c: GCalendar) => c.summaryOverride || c.summary || c.id;

export type GEvent = {
  id: string;
  status?: string;
  transparency?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  attendees?: { self?: boolean; responseStatus?: string }[];
};

const iso = (ms: number) => new Date(ms).toISOString();
const MAX_PAGES = 20;

/** Every event overlapping [timeMin, timeMax), recurring ones expanded. */
export async function listEvents(access: string, calendarId: string, timeMin: number, timeMax: number, timeoutMs = DEFAULT_TIMEOUT): Promise<GEvent[]> {
  const out: GEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const p = new URLSearchParams({
      singleEvents: "true", timeMin: iso(timeMin), timeMax: iso(timeMax), maxResults: "2500",
      fields: "nextPageToken,items(id,status,transparency,eventType,start,end,extendedProperties/private,attendees(self,responseStatus))",
    });
    if (pageToken) p.set("pageToken", pageToken);
    const body = await api(access, `/calendars/${encodeURIComponent(calendarId)}/events?${p}`, { timeoutMs });
    out.push(...((body?.items ?? []) as GEvent[]));
    pageToken = body?.nextPageToken;
    if (!pageToken) return out;
  }
  throw new GoogleError(0, "too_many_events");
}

export type GEventBody = Record<string, unknown> & { id: string };

/** Create or update the event with this id. `exists`: our best guess, tried first (saves a call). */
export async function putEvent(access: string, calendarId: string, event: GEventBody, exists: boolean): Promise<void> {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const insert = () => api(access, `${base}?sendUpdates=none`, { method: "POST", json: event });
  const update = () => api(access, `${base}/${event.id}?sendUpdates=none`, { method: "PUT", json: event });
  const is = (err: unknown, status: number) => err instanceof GoogleError && err.status === status;
  if (exists) {
    try {
      await update();
    } catch (err) {
      if (!is(err, 404)) throw err;
      await insert();
    }
    return;
  }
  try {
    await insert();
  } catch (err) {
    if (!is(err, 409)) throw err; // the id is taken (a retry, or an event deleted earlier): update it instead
    await update();
  }
}

/** Already gone counts as done. */
export async function deleteEvent(access: string, calendarId: string, eventId: string): Promise<void> {
  try {
    await api(access, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=none`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}
