import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { bookableOwner, call } from "./helpers";
import { CONSENT_WORDING } from "../src/worker/routes/public";

type Contact = { first_name: string; last_name: string; phone: string | null; email: string | null };
type HostAppt = { status: string; note: string; cancel_reason: string | null; contact: Contact; customer: Contact & { id: string } };
type Booked = { appointment: { id: string; start: string; status: string; customer: { id: string } }; manage_token: string; manage_path: string };

async function setup() {
  const b = await bookableOwner();
  const hidden = (await (await call("/api/v1/services", { method: "POST", who: b.owner, json: { name: "Secret", duration_min: 30, hidden: true } })).json()) as { id: string };
  await call("/api/v1/calendar", { method: "PATCH", who: b.owner, json: { branding: { business_name: "Acme Fence" } } });
  return { ...b, hiddenId: hidden.id };
}

const customerIdOf = async (owner: { key: string; user: string }, apptId: string) =>
  ((await (await call(`/api/v1/appointments/${apptId}`, { who: owner })).json()) as HostAppt).customer.id;

const bookPublic = (slug: string, json: Record<string, unknown>) => call(`/api/public/${slug}/book`, { method: "POST", json });

describe("public calendar", () => {
  it("gives customers the page style on the booking and manage pages", async () => {
    const { owner, serviceId, slots } = await setup();
    await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { branding: { style: "soft" } } });
    const cal = (await (await call(`/api/public/${owner.slug}`)).json()) as { branding: { style: string } };
    expect(cal.branding.style).toBe("soft");

    const booked = (await (await bookPublic(owner.slug, { service_id: serviceId, start: slots[0], first_name: "Ann", phone: "5035550702" })).json()) as Booked;
    const view = (await (await call(`/api/public/manage/${booked.manage_token}`)).json()) as { business: { style: string } };
    expect(view.business.style).toBe("soft");
  });

  it("shows branding and only visible services", async () => {
    const { owner, serviceId } = await setup();
    const res = await call(`/api/public/${owner.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branding: { business_name: string }; services: { id: string }[]; booking: { required_fields: { phone: boolean } } };
    expect(body.branding.business_name).toBe("Acme Fence");
    expect(body.services.map((s) => s.id)).toEqual([serviceId]);
    expect(body.booking.required_fields.phone).toBe(true);
    expect((await call("/api/public/no-such-calendar")).status).toBe(404);
  });

  it("hides open times for hidden services", async () => {
    const { owner, hiddenId, date } = await setup();
    expect((await call(`/api/public/${owner.slug}/slots?service_id=${hiddenId}&date=${date}`)).status).toBe(404);
  });

  it("refuses text consent without a phone number", async () => {
    const { owner, serviceId, slots } = await setup();
    const required_fields = { first_name: true, last_name: false, email: true, phone: false };
    await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { required_fields } } });
    const res = await bookPublic(owner.slug, { service_id: serviceId, start: slots[0], first_name: "Ann", email: "ann@example.com", text_consent: { wording: CONSENT_WORDING } });
    expect(res.status).toBe(400);
  });

  it("books with the required fields and records text consent", async () => {
    const { owner, serviceId, slots } = await setup();
    const missing = await bookPublic(owner.slug, { service_id: serviceId, start: slots[0], first_name: "Ann" });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { missing: string[] }).missing).toEqual(["phone"]);

    const wording = CONSENT_WORDING;
    const res = await bookPublic(owner.slug, { service_id: serviceId, start: slots[0], first_name: "Ann", phone: "5035550601", text_consent: { wording } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Booked;
    expect(body.manage_path).toBe(`/m/${body.manage_token}`);
    const consent = await env.DB.prepare("SELECT kind, wording, phone FROM consents WHERE appointment_id = ?").bind(body.appointment.id).first();
    expect(consent).toEqual({ kind: "sms", wording, phone: "5035550601" });

    const again = await bookPublic(owner.slug, { service_id: serviceId, start: slots[0], first_name: "Bob", phone: "5035550602" });
    expect(again.status).toBe(409);
  });

  it("won't book a hidden service from the public page", async () => {
    const { owner, hiddenId, slots } = await setup();
    expect((await bookPublic(owner.slug, { service_id: hiddenId, start: slots[0], first_name: "A", phone: "5035550603" })).status).toBe(404);
  });
});

describe("manage link", () => {
  async function booked() {
    const s = await setup();
    const res = (await (await bookPublic(s.owner.slug, { service_id: s.serviceId, start: s.slots[0], first_name: "Ann", phone: "5035550701" })).json()) as Booked;
    return { ...s, token: res.manage_token, apptId: res.appointment.id };
  }

  it("shows the appointment and reschedules it", async () => {
    const { token, slots } = await booked();
    const view = (await (await call(`/api/public/manage/${token}`)).json()) as { appointment: { start: string }; business: { business_name: string }; can_change: boolean; max_days_ahead: number; powered_by: boolean };
    expect(view).toMatchObject({ appointment: { start: slots[0] }, business: { business_name: "Acme Fence" }, can_change: true, max_days_ahead: 730, powered_by: true });

    const date = slots[0].slice(0, 10);
    const open = ((await (await call(`/api/public/manage/${token}/slots?date=${date}`)).json()) as { slots: string[] }).slots;
    expect(open).toContain(slots[0]); // its own time doesn't block itself

    const moved = await call(`/api/public/manage/${token}/reschedule`, { method: "POST", json: { start: slots[6] } });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { appointment: { start: string } }).appointment.start).toBe(slots[6]);
  });

  it("cancels, needing a reason when the owner asks for one", async () => {
    const { owner, token } = await booked();
    await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { cancel_reason_required: true } } });
    expect((await call(`/api/public/manage/${token}/cancel`, { method: "POST", json: {} })).status).toBe(400);
    const ok = await call(`/api/public/manage/${token}/cancel`, { method: "POST", json: { reason: "Sick" } });
    expect(ok.status).toBe(200);
    expect((await call(`/api/public/manage/${token}/cancel`, { method: "POST", json: { reason: "Again" } })).status).toBe(409);
    expect((await call(`/api/public/manage/${token}/reschedule`, { method: "POST", json: { start: new Date().toISOString() } })).status).toBe(409);
  });

  it("blocks changes inside the cutoff, checked when submitted", async () => {
    const { owner, token, slots } = await booked();
    // Booking is ~30 days out; a 60-day cutoff makes it too late.
    await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { change_cutoff_hours: 1440 } } });
    const view = (await (await call(`/api/public/manage/${token}`)).json()) as { can_change: boolean };
    expect(view.can_change).toBe(false);
    const res = await call(`/api/public/manage/${token}/reschedule`, { method: "POST", json: { start: slots[6] } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("too_late");
    expect((await call(`/api/public/manage/${token}/cancel`, { method: "POST", json: { reason: "x" } })).status).toBe(409);
  });

  it("deletes my data: cancels this booking, clears its details and flags the request", async () => {
    const s = await setup();
    const wording = CONSENT_WORDING;
    const res = (await (await bookPublic(s.owner.slug, {
      service_id: s.serviceId, start: s.slots[0], first_name: "Ann", last_name: "Lee", phone: "5035550702", email: "ann@example.com", note: "Gate code 1234", text_consent: { wording },
    })).json()) as Booked;
    const apptId = res.appointment.id;
    expect((await call(`/api/public/manage/${res.manage_token}/delete-my-data`, { method: "POST" })).status).toBe(204);
    const appt = (await (await call(`/api/v1/appointments/${apptId}`, { who: s.owner })).json()) as HostAppt;
    expect(appt).toMatchObject({ status: "cancelled", note: "", cancel_reason: "Customer deleted their data" });
    expect(appt.contact).toEqual({ first_name: "Deleted", last_name: "", phone: null, email: null });
    expect(await env.DB.prepare("SELECT 1 FROM consents WHERE appointment_id = ?").bind(apptId).first()).toBeNull();
    // The customer record is the owner's to scrub; it is flagged, not changed.
    expect(appt.customer).toMatchObject({ first_name: "Ann", last_name: "Lee", phone: "5035550702", email: "ann@example.com" });
    const cus = (await (await call(`/api/v1/customers/${appt.customer.id}`, { who: s.owner })).json()) as { delete_requested_at: string | null; delete_request_appointment_id: string | null };
    expect(cus.delete_requested_at).not.toBeNull();
    expect(cus.delete_request_appointment_id).toBe(apptId);
  });

  it("won't list open times for a cancelled booking or past the cutoff", async () => {
    const { owner, token, slots } = await booked();
    const date = slots[0].slice(0, 10);
    await call(`/api/v1/calendar`, { method: "PATCH", who: owner, json: { rules: { change_cutoff_hours: 1440 } } });
    const late = await call(`/api/public/manage/${token}/slots?date=${date}`);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { error: string }).error).toBe("too_late");
    await call(`/api/v1/calendar`, { method: "PATCH", who: owner, json: { rules: { change_cutoff_hours: 0 } } });
    await call(`/api/public/manage/${token}/cancel`, { method: "POST", json: {} });
    const res = await call(`/api/public/manage/${token}/slots?date=${date}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_active");
  });

  it("returns 404 for an unknown token", async () => {
    expect((await call("/api/public/manage/not-a-real-token")).status).toBe(404);
  });
});

describe("someone else's email or phone", () => {
  async function victimAndAttacker() {
    const s = await setup();
    const victim = (await (await bookPublic(s.owner.slug, {
      service_id: s.serviceId, start: s.slots[0], first_name: "Victim", last_name: "Secret", phone: "5035552001", email: "victim@example.com",
    })).json()) as Booked;
    const res = await bookPublic(s.owner.slug, { service_id: s.serviceId, start: s.slots[4], first_name: "Eve", email: " VICTIM@example.com", phone: "5035559999" });
    return { ...s, victim, res };
  }
  const eve = { first_name: "Eve", last_name: "", phone: "5035559999", email: "victim@example.com" };
  const leaks = (body: unknown) => /Victim|Secret|5035552001/.test(JSON.stringify(body));

  it("the booking reply shows only what was submitted", async () => {
    const { res } = await victimAndAttacker();
    expect(res.status).toBe(201);
    const body = (await res.json()) as Booked & { appointment: { contact: Contact } };
    expect(body.appointment.contact).toEqual(eve);
    expect(body.appointment).not.toHaveProperty("customer");
    expect(leaks(body)).toBe(false);
  });

  it("the manage link shows only what was submitted", async () => {
    const { res } = await victimAndAttacker();
    const { manage_token } = (await res.json()) as Booked;
    const view = (await (await call(`/api/public/manage/${manage_token}`)).json()) as { appointment: { contact: Contact } };
    expect(view.appointment.contact).toEqual(eve);
    expect(leaks(view)).toBe(false);
  });

  it("delete-my-data can't touch the other person's booking or record", async () => {
    const { owner, victim, res } = await victimAndAttacker();
    const { manage_token } = (await res.json()) as Booked;
    expect((await call(`/api/public/manage/${manage_token}/delete-my-data`, { method: "POST" })).status).toBe(204);
    const v = (await (await call(`/api/v1/appointments/${victim.appointment.id}`, { who: owner })).json()) as HostAppt;
    expect(v.status).toBe("booked");
    expect(v.contact).toEqual({ first_name: "Victim", last_name: "Secret", phone: "5035552001", email: "victim@example.com" });
    const cus = (await (await call(`/api/v1/customers/${await customerIdOf(owner, victim.appointment.id)}`, { who: owner })).json()) as Contact & { delete_requested_at: string | null };
    expect(cus).toMatchObject({ first_name: "Victim", last_name: "Secret", phone: "5035552001", email: "victim@example.com" });
    expect(cus.delete_requested_at).not.toBeNull(); // the owner sees the request and decides
  });

  it("a returning customer's booking doesn't change their stored details", async () => {
    const s = await setup();
    const first = (await (await bookPublic(s.owner.slug, { service_id: s.serviceId, start: s.slots[0], first_name: "Ann", phone: "5035552002" })).json()) as Booked;
    const res = await bookPublic(s.owner.slug, { service_id: s.serviceId, start: s.slots[4], first_name: "Annie", last_name: "Lee", phone: "5035552002", email: "ann2@example.com" });
    expect(res.status).toBe(201);
    const cus = (await (await call(`/api/v1/customers/${await customerIdOf(s.owner, first.appointment.id)}`, { who: s.owner })).json()) as Contact;
    expect(cus).toMatchObject({ first_name: "Ann", last_name: "", phone: "5035552002", email: null });
  });
});

describe("the customer's time zone", () => {
  const zoneOf = async (id: string) =>
    (await env.DB.prepare("SELECT customer_time_zone AS z FROM appointments WHERE id = ?").bind(id).first<{ z: string | null }>())!.z;

  it("is kept from the booking page, and an unknown zone is ignored rather than refused", async () => {
    const { owner, serviceId, slots } = await setup();
    const good = await bookPublic(owner.slug, { service_id: serviceId, start: slots[0], first_name: "Zed", phone: "503-555-0161", time_zone: "America/New_York" });
    expect(good.status).toBe(201);
    const a = (await good.json()) as Booked;
    expect(await zoneOf(a.appointment.id)).toBe("America/New_York");

    const odd = await bookPublic(owner.slug, { service_id: serviceId, start: slots[2], first_name: "Yan", phone: "503-555-0162", time_zone: "Mars/Olympus" });
    expect(odd.status).toBe(201);
    expect(await zoneOf(((await odd.json()) as Booked).appointment.id)).toBeNull();

    const moved = await call(`/api/public/manage/${a.manage_token}/reschedule`, { method: "POST", json: { start: slots[4], time_zone: "Europe/London" } });
    expect(moved.status).toBe(200);
    expect(await zoneOf(a.appointment.id)).toBe("Europe/London");
  });
});

describe("email flags", () => {
  it("say no emails are sent when email isn't set up", async () => {
    const { owner } = await setup();
    const cal = (await (await call(`/api/public/${owner.slug}`)).json()) as { emails: Record<string, boolean> };
    expect(cal.emails).toEqual({ booked: false, changed: false, cancelled: false });
  });
});
