// Typed helpers for the public API. Every failure is thrown as an ApiError.

import type { PageStyle } from "./theme";

export type Field = "first_name" | "last_name" | "email" | "phone";

export interface Branding {
  business_name: string;
  phone: string;
  tagline: string;
  color: string;
  style: PageStyle;
  logo_url: string | null;
  hero_url: string | null;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  duration_min: number;
  price_cents: number | null;
  currency: string;
}

/** Which emails customers of this calendar get (false when email isn't set up). */
export interface CustomerEmails {
  booked: boolean;
  changed: boolean;
  cancelled: boolean;
}

export interface PublicCalendar {
  slug: string;
  emails: CustomerEmails;
  time_zone: string;
  consent_wording: string;
  turnstile_site_key: string | null;
  branding: Branding;
  services: Service[];
  /** A White-label client whose agency isn't on White-label: no online booking. */
  paused: boolean;
  booking: {
    required_fields: Record<Field, boolean>;
    cancel_reason_required: boolean;
    change_cutoff_hours: number;
    max_days_ahead: number;
    powered_by: boolean;
  };
}

export interface Appointment {
  id: string;
  service_name: string;
  start: string;
  end: string;
  status: "booked" | "confirmed" | "cancelled" | "completed" | "no_show" | string;
  cancel_reason: string | null;
  contact: { first_name: string; last_name: string; phone: string | null; email: string | null };
}

export interface Booked {
  appointment: Appointment;
  manage_token: string;
  manage_path: string;
}

export interface ManageView {
  appointment: Appointment;
  business: Branding;
  time_zone: string;
  can_change: boolean;
  emails: CustomerEmails;
  change_cutoff_hours: number;
  cancel_reason_required: boolean;
  max_days_ahead: number;
  powered_by: boolean;
}

export interface BookInput {
  service_id: string;
  start: string;
  first_name: string;
  last_name?: string;
  email?: string;
  phone?: string;
  note?: string;
  text_consent?: { wording: string };
  turnstile_token?: string;
  /** The zone the times were shown in, so emails match what the customer saw. */
  time_zone?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    public missing: string[] = [],
  ) {
    super(error);
  }
}

async function request<T>(path: string, init?: { method?: string; json?: unknown; base?: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${init?.base ?? "/api/public"}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new ApiError(res.ok ? 0 : res.status, res.ok ? "network" : "unknown");
  if (!res.ok) {
    // Zod issues name the bad field in path[0]; fold them into `missing` so the form can point at them.
    const issues = Array.isArray(body.issues) ? (body.issues as { path?: unknown[] }[]) : [];
    const missing = [
      ...(Array.isArray(body.missing) ? (body.missing as string[]) : []),
      ...issues.map((i) => String(i.path?.[0] ?? "")).filter(Boolean),
    ];
    throw new ApiError(res.status, String(body.error ?? "unknown"), missing);
  }
  return body as T;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const enc = encodeURIComponent;

/** Where to read open days and times: a booking page's service, or an existing appointment. */
export type SlotSource = { kind: "slug"; slug: string; serviceId: string } | { kind: "manage"; token: string };

export const api = {
  calendar: (slug: string) => request<PublicCalendar>(`/${enc(slug)}`),
  days: (src: SlotSource, month: string) =>
    request<{ days: string[] }>(
      src.kind === "slug"
        ? `/${enc(src.slug)}/days?${q({ service_id: src.serviceId, month })}`
        : `/manage/${enc(src.token)}/days?${q({ month })}`,
    ),
  slots: (src: SlotSource, date: string) =>
    request<{ slots: string[] }>(
      src.kind === "slug"
        ? `/${enc(src.slug)}/slots?${q({ service_id: src.serviceId, date })}`
        : `/manage/${enc(src.token)}/slots?${q({ date })}`,
    ),
  book: (slug: string, input: BookInput) => request<Booked>(`/${enc(slug)}/book`, { method: "POST", json: input }),
  manage: (token: string) => request<ManageView>(`/manage/${enc(token)}`),
  reschedule: (token: string, start: string, timeZone: string) =>
    request<{ appointment: Appointment }>(`/manage/${enc(token)}/reschedule`, { method: "POST", json: { start, time_zone: timeZone } }),
  cancel: (token: string, reason: string) =>
    request<{ appointment: Appointment }>(`/manage/${enc(token)}/cancel`, {
      method: "POST",
      json: reason ? { reason } : {},
    }),
  deleteMyData: (token: string) => request<void>(`/manage/${enc(token)}/delete-my-data`, { method: "POST" }),
};

export const icsUrl = (token: string) => `/api/public/manage/${enc(token)}/ics`;

/** Plain-language text for an API failure. */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Please try again.";
  switch (e.error) {
    case "network":
      return "We couldn't reach the server. Check your connection and try again.";
    case "slot_taken":
    case "slot_unavailable":
      return "That time was just taken. Please pick another.";
    case "too_late":
      return "It's too close to the appointment to change it online.";
    case "not_active":
      return "This appointment can no longer be changed.";
    case "not_found":
      return "We couldn't find that.";
    case "booking_paused":
      return "Online booking is paused. Please contact the business.";
    case "turnstile_failed":
      return "We couldn't verify you're not a robot. Please try the check again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export interface AccountConfig { google: boolean; email: boolean; passwords: boolean; turnstile_site_key: string | null; public_url: string; open?: boolean }
/** A calendar's look for its sign-in pages. */
export interface LoginBrand {
  slug: string;
  name: string;
  logo_url: string | null;
  color: string;
  style: string;
}
export type HostedSession = { token: string; expires_at: string; client_slug: string | null };
const ACCOUNT = "/api/account";
export const accountApi = {
  config: () => request<AccountConfig>("/config", { base: ACCOUNT }),
  invite: (token: string) => request<{ valid: boolean }>(`/invite/${enc(token)}`, { base: ACCOUNT }),
  emailLink: (input: { email: string; invite?: string; turnstile_token?: string }) =>
    request<{ sent: true }>("/email-link", { method: "POST", json: input, base: ACCOUNT }),
  verify: (token: string) => request<{ token: string; expires_at: string; email: string }>("/email-link/verify", { method: "POST", json: { token }, base: ACCOUNT }),
  passwordLogin: (input: { email: string; password: string; turnstile_token?: string }) =>
    request<HostedSession>("/password-login", { method: "POST", json: input, base: ACCOUNT }),
  loginPage: (slug: string) => request<LoginBrand>(`/login-page/${enc(slug)}`, { base: ACCOUNT }),
  inviteCheck: (token: string) =>
    request<{ valid: false } | ({ valid: true; email: string } & LoginBrand)>("/client-invite/check", { method: "POST", json: { token }, base: ACCOUNT }),
  inviteAccept: (token: string, password: string) =>
    request<HostedSession>("/client-invite/accept", { method: "POST", json: { token, password }, base: ACCOUNT }),
};
