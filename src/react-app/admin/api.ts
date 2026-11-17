// Typed helpers for the owner API (/api/admin/*). Every failure is thrown as an ApiError.

import { ApiError, type Branding, type Field } from "../api";
import { clearToken, getToken } from "./session";

/** Booking rules; mirrors RulesSchema on the server. */
export interface Rules {
  buffer_min: 0 | 15 | 30;
  max_per_day: number | null;
  min_notice_min: number;
  max_days_ahead: number;
  change_cutoff_hours: number;
  slot_step_min: number;
  /** Always sent whole: the server replaces it, it doesn't merge it. */
  required_fields: Record<Field, boolean>;
  cancel_reason_required: boolean;
  /** Google all-day events block the whole day. */
  block_all_day_google: boolean;
  powered_by: boolean;
}

/** Email settings; mirrors NotificationsSchema on the server. */
export interface Notifications {
  owner_email: string;
  customer_confirmation: boolean;
  customer_change: boolean;
  customer_cancel: boolean;
  owner_new: boolean;
  owner_change: boolean;
  owner_cancel: boolean;
  reminder: boolean;
  reminder_mode: "smart" | "hours_before";
  reminder_hours_before: number;
  confirmation_message: string;
}

export interface AdminCalendar {
  id: string;
  slug: string;
  time_zone: string;
  rules: Rules;
  branding: Branding;
  notifications: Notifications;
  /** False when this install has no sending address set up, so nothing is emailed. */
  email_enabled: boolean;
}

let onUnauthorized = () => {};
/** Called when any request comes back 401, after the token is cleared. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(path: string, init?: { method?: string; json?: unknown; body?: Blob; auth?: boolean }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.json !== undefined) headers["Content-Type"] = "application/json";
  const auth = init?.auth !== false;
  const sent = getToken();
  if (auth) headers.Authorization = `Session ${sent ?? ""}`;
  let res: Response;
  try {
    res = await fetch(`/api/admin${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  if (res.status === 401 && auth) {
    // A late 401 for an old token must not sign out a newer one (a fresh link or login).
    if (getToken() === sent) {
      clearToken();
      onUnauthorized();
    }
    throw new ApiError(401, "unauthorized");
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // Zod issues name the bad field in path[0]; keep them so a form can point at it.
    const issues = Array.isArray(body?.issues) ? (body.issues as { path?: unknown[] }[]) : [];
    throw new ApiError(res.status, String(body?.error ?? "unknown"), issues.map((i) => String(i.path?.[0] ?? "")).filter(Boolean));
  }
  if (!body) throw new ApiError(0, "network");
  return body as T;
}

export interface Contact {
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
}

export interface Customer extends Contact {
  id: string;
  notes: string;
  external_ref: string | null;
  created_at: string;
  /** Set when someone used a manage link to ask for this customer's data to be deleted. */
  delete_requested_at: string | null;
  delete_request_appointment_id: string | null;
}

/** Empty optional fields are left out (adding) or sent as null (editing): the server refuses "". */
export interface CustomerInput {
  first_name: string;
  last_name?: string;
  phone?: string | null;
  email?: string | null;
  notes?: string;
}

export interface CustomerHistory {
  appointments: AdminAppointment[];
  /** `booked` means "not cancelled": it includes done and no-show. */
  counts: { booked: number; completed: number; cancelled: number };
  first_booked: string | null;
}

export type Status = "booked" | "confirmed" | "done" | "no_show" | "cancelled";

export interface AdminAppointment {
  id: string;
  service_id: string;
  service_name: string;
  customer: Customer;
  /** What was typed when this appointment was booked. */
  contact: Contact;
  start: string;
  end: string;
  status: Status;
  source: string;
  note: string;
  cancel_reason: string | null;
}

export type LocationType = "phone" | "video" | "their_place" | "business" | "other";

/** What the owner can set on a service. */
export interface ServiceInput {
  name: string;
  description: string;
  duration_min: number;
  price_cents: number | null;
  color: string;
  location_type: LocationType;
  location_text: string;
  hidden: boolean;
  is_call_default: boolean;
}

export interface AdminService extends ServiceInput {
  id: string;
  currency: string;
}

export interface Reminder {
  id: string;
  at: string;
  title: string;
  done: boolean;
}

/** A busy time copied from the owner's Google Calendar. Times only. */
export interface GoogleBusy {
  start: string;
  end: string;
}

export interface TimeBlock {
  id: string;
  start_at: string;
  end_at: string;
  note: string;
}

export interface Break {
  start_min: number;
  end_min: number;
}

export interface WeeklyDay {
  weekday: number;
  open: boolean;
  start_min: number;
  end_min: number;
  breaks: Break[];
}

/** Different hours (or closed) on one date. */
export interface Override {
  on_date: string;
  closed: boolean;
  start_min: number | null;
  end_min: number | null;
  breaks: Break[];
}

export interface BlockedDates {
  id: string;
  start_date: string;
  end_date: string;
  label: string;
}

export interface Availability {
  weekly: WeeklyDay[];
  overrides: Override[];
  blocked_dates: BlockedDates[];
}

export interface DashboardData {
  today: number;
  this_week: number;
  this_month: number;
  customers: number;
  today_appointments: AdminAppointment[];
  recent_customers: Customer[];
}

export interface Created {
  appointment: AdminAppointment;
  manage_path: string;
}

export interface NewAppointment {
  service_id: string;
  start: string;
  customer_id?: string;
  customer?: { first_name: string; last_name?: string; phone?: string; email?: string };
  note: string;
  source: string;
  allow_outside_hours: boolean;
}

const range = (from: string, to: string) => new URLSearchParams({ from, to }).toString();
const enc = encodeURIComponent;

export const STATUS_LABEL: Record<Status, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  done: "Done",
  no_show: "No-show",
  cancelled: "Cancelled",
};

export const fullName = (c: Contact) => `${c.first_name} ${c.last_name}`.trim();

/** Plain-language text for a failed owner action. */
export function adminErrorText(e: unknown): string {
  const code = e instanceof ApiError ? e.error : "";
  switch (code) {
    case "slot_taken":
      return "That time is taken.";
    case "slot_unavailable":
      return "That time is outside your open hours or booking rules.";
    case "not_active":
      return "Reopen it first.";
    case "invalid_input":
      return "Something in the form isn't right. Check the phone number and email.";
    case "customer_exists":
      return "Another customer already has that phone or email.";
    case "slug_taken":
      return "That link is taken. Try another.";
    case "too_large":
      return "That file is too big.";
    case "unsupported_image":
      return "Use a PNG, JPEG or WebP image.";
    case "google_unavailable":
      return "Couldn't reach Google. Try again in a minute.";
    case "not_connected":
      return "Google Calendar isn't connected anymore. Reload the page.";
    case "network":
      return "We couldn't reach the server. Check your connection and try again.";
    case "unauthorized":
      return "Your session ended.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export const adminApi = {
  dashboard: () => request<DashboardData>("/dashboard"),
  services: () => request<{ services: AdminService[] }>("/services"),
  createService: (input: ServiceInput) => request<AdminService>("/services", { method: "POST", json: input }),
  updateService: (id: string, patch: Partial<ServiceInput>) =>
    request<AdminService>(`/services/${enc(id)}`, { method: "PATCH", json: patch }),
  deleteService: (id: string) => request<void>(`/services/${enc(id)}`, { method: "DELETE" }),
  orderServices: (ids: string[]) => request<void>("/services/order", { method: "PUT", json: { ids } }),
  availability: () => request<Availability>("/availability"),
  saveWeekly: (days: WeeklyDay[]) => request<Availability>("/availability/weekly", { method: "PUT", json: { days } }),
  putOverride: (date: string, input: { closed: boolean; start_min?: number; end_min?: number; breaks?: Break[] }) =>
    request<Override>(`/availability/overrides/${enc(date)}`, { method: "PUT", json: input }),
  deleteOverride: (date: string) => request<void>(`/availability/overrides/${enc(date)}`, { method: "DELETE" }),
  blockDates: (input: { start_date: string; end_date: string; label: string }) =>
    request<BlockedDates>("/availability/blocked", { method: "POST", json: input }),
  unblockDates: (id: string) => request<void>(`/availability/blocked/${enc(id)}`, { method: "DELETE" }),
  appointments: (from: string, to: string, serviceId?: string) =>
    request<{ appointments: AdminAppointment[] }>(
      `/appointments?${new URLSearchParams({ from, to, ...(serviceId && { service_id: serviceId }) })}`,
    ),
  appointment: (id: string) => request<AdminAppointment & { manage_token: string }>(`/appointments/${enc(id)}`),
  createAppointment: (input: NewAppointment) => request<Created>("/appointments", { method: "POST", json: input }),
  updateAppointment: (
    id: string,
    patch: { start?: string; status?: Status; note?: string; allow_outside_hours?: boolean },
  ) => request<AdminAppointment>(`/appointments/${enc(id)}`, { method: "PATCH", json: patch }),
  cancelAppointment: (id: string, reason: string) =>
    request<AdminAppointment>(`/appointments/${enc(id)}/cancel`, { method: "POST", json: reason ? { reason } : {} }),
  reminders: (from: string, to: string) => request<{ reminders: Reminder[] }>(`/reminders?${range(from, to)}`),
  googleBusy: (from: string, to: string) => request<{ busy: GoogleBusy[] }>(`/google/busy?${range(from, to)}`),
  timeBlocks: (from: string, to: string) =>
    request<{ time_blocks: TimeBlock[] }>(`/availability/time-blocks?${range(from, to)}`),
  createTimeBlock: (input: { start_at: string; end_at: string; note: string }) =>
    request<TimeBlock>("/availability/time-blocks", { method: "POST", json: input }),
  deleteTimeBlock: (id: string) => request<void>(`/availability/time-blocks/${enc(id)}`, { method: "DELETE" }),
  customers: (q: string) => request<{ customers: Customer[] }>(`/customers?${new URLSearchParams({ q })}`),
  customer: (id: string) => request<Customer>(`/customers/${enc(id)}`),
  customerHistory: (id: string) => request<CustomerHistory>(`/customers/${enc(id)}/appointments`),
  createCustomer: (input: CustomerInput) =>
    request<{ customer: Customer; created: boolean }>("/customers", { method: "POST", json: input }),
  updateCustomer: (id: string, patch: Partial<CustomerInput>) =>
    request<Customer>(`/customers/${enc(id)}`, { method: "PATCH", json: patch }),
  deleteCustomer: (id: string) => request<void>(`/customers/${enc(id)}`, { method: "DELETE" }),
  dismissDeleteRequest: (id: string) =>
    request<Customer>(`/customers/${enc(id)}/dismiss-delete-request`, { method: "POST" }),
  /** The file itself is the request body. The server judges the type by its contents. */
  uploadImage: (kind: "logo" | "hero", file: Blob) =>
    request<{ key: string; url: string }>(`/images/${kind}`, { method: "PUT", body: file }),
  removeImage: (kind: "logo" | "hero") => request<void>(`/images/${kind}`, { method: "DELETE" }),
  slots: (serviceId: string, date: string) =>
    request<{ slots: string[] }>(`/slots?${new URLSearchParams({ service_id: serviceId, date })}`),

  /** Password login for standalone installs. 404 means this install signs in from a host app. */
  login: (password: string) =>
    request<{ token: string }>("/login", { method: "POST", json: { password }, auth: false }),
  calendar: () => request<AdminCalendar>("/calendar"),
  account: () => request<{ email: string }>("/account"),
  createCalendar: (input: { slug: string; time_zone: string }) =>
    request<AdminCalendar>("/calendar", { method: "POST", json: input }),
  updateCalendar: (patch: { slug?: string; time_zone?: string; rules?: Partial<Rules>; branding?: Partial<Branding>; notifications?: Partial<Notifications> }) =>
    request<AdminCalendar>("/calendar", { method: "PATCH", json: patch }),
  google: () => request<GoogleStatus>("/google"),
  connectGoogle: () => request<{ url: string }>("/google/connect", { method: "POST" }),
  googleCalendars: () => request<{ calendars: GoogleCalendarChoice[] }>("/google/calendars"),
  setGoogleCalendar: (id: string) => request<GoogleStatus>("/google/calendar", { method: "PUT", json: { id } }),
  syncGoogle: () => request<GoogleStatus>("/google/sync", { method: "POST" }),
  disconnectGoogle: () => request<void>("/google", { method: "DELETE" }),
};

/** The Google Calendar connection, as the server reports it. Never holds tokens. */
export interface GoogleStatus {
  /** False when this install hasn't set Google up at all. */
  configured: boolean;
  status: "active" | "broken" | "not_connected";
  email: string | null;
  calendar: { id: string; name: string } | null;
  last_synced_at: string | null;
  /** Why it's broken: signed_out, missing_permission, calendar_missing, token_unreadable, or another short code. */
  problem: string | null;
  /** Connected, but something keeps failing: "push_failed" or "sync_failing". */
  warning: "push_failed" | "sync_failing" | null;
}

export interface GoogleCalendarChoice {
  id: string;
  name: string;
  primary: boolean;
}

/** True if a public booking page already uses this link name. */
export async function slugInUse(slug: string): Promise<boolean> {
  const res = await fetch(`/api/public/${encodeURIComponent(slug)}`);
  return res.ok;
}
