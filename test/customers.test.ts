import { describe, it, expect } from "vitest";
import { bookableOwner, call, newOwner, testEnv } from "./helpers";

type Customer = { id: string; first_name: string; phone: string | null; email: string | null; external_ref: string | null };

describe("customers", () => {
  it("adds a customer and reuses them for the same phone in another format", async () => {
    const owner = await newOwner();
    const first = await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "Mike", last_name: "Smith", phone: "(503) 555-0142", external_ref: "lead_1" } });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { customer: Customer; created: boolean };
    expect(a.created).toBe(true);
    expect(a.customer.phone).toBe("(503) 555-0142");

    const again = await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "Michael", phone: "+1 503 555 0142" } });
    expect(again.status).toBe(200);
    const b = (await again.json()) as { customer: Customer; created: boolean };
    expect(b).toMatchObject({ created: false, customer: { id: a.customer.id, first_name: "Mike" } });
  });

  it("matches on email ignoring case", async () => {
    const owner = await newOwner();
    const a = (await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "A", email: "Mike@Example.com" } })).json()) as { customer: Customer };
    const b = await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "B", email: "mike@example.com " } });
    expect(b.status).toBe(200);
    expect(((await b.json()) as { customer: Customer }).customer.id).toBe(a.customer.id);
  });

  it("needs a name and a phone or email", async () => {
    const owner = await newOwner();
    expect((await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "A" } })).status).toBe(400);
    expect((await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "A", phone: "123" } })).status).toBe(400);
  });

  it("searches, finds by external_ref, edits and deletes", async () => {
    const owner = await newOwner();
    const { customer } = (await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "Mike", phone: "5035550123", external_ref: "lead_9" } })).json()) as { customer: Customer };

    const search = (await (await call("/api/v1/customers?q=503555", { who: owner })).json()) as { customers: Customer[] };
    expect(search.customers.map((x) => x.id)).toEqual([customer.id]);
    const byRef = (await (await call("/api/v1/customers?external_ref=lead_9", { who: owner })).json()) as { customers: Customer[] };
    expect(byRef.customers.map((x) => x.id)).toEqual([customer.id]);

    const edit = await call(`/api/v1/customers/${customer.id}`, { method: "PATCH", who: owner, json: { notes: "Prefers mornings" } });
    expect(edit.status).toBe(200);

    expect((await call(`/api/v1/customers/${customer.id}`, { method: "DELETE", who: owner })).status).toBe(204);
    expect((await call(`/api/v1/customers/${customer.id}`, { who: owner })).status).toBe(404);
    const again = await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "Mike", phone: "5035550123" } });
    expect(again.status).toBe(201);
  });

  it("won't let an edit take another customer's phone", async () => {
    const owner = await newOwner();
    await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "A", phone: "5035550001" } });
    const b = (await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "B", phone: "5035550002" } })).json()) as { customer: Customer };
    const res = await call(`/api/v1/customers/${b.customer.id}`, { method: "PATCH", who: owner, json: { phone: "503-555-0001" } });
    expect(res.status).toBe(409);
  });

  it("only matches phone digits when the search looks like a phone number", async () => {
    const owner = await newOwner();
    const bob = (await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "Bob", email: "bob1@example.com" } })).json()) as { customer: Customer };
    const alice = (await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "Alice", phone: "5035550000" } })).json()) as { customer: Customer };
    const byEmail = (await (await call("/api/v1/customers?q=bob1%40example.com", { who: owner })).json()) as { customers: Customer[] };
    expect(byEmail.customers.map((x) => x.id)).toEqual([bob.customer.id]);
    const byPhone = (await (await call("/api/v1/customers?q=(503)%20555", { who: owner })).json()) as { customers: Customer[] };
    expect(byPhone.customers.map((x) => x.id)).toEqual([alice.customer.id]);
  });

  it("returns 409, not 500, when two edits race for the same email", async () => {
    const owner = await newOwner();
    const make = async (phone: string) =>
      ((await (await call("/api/v1/customers", { method: "POST", who: owner, json: { first_name: "X", phone } })).json()) as { customer: Customer }).customer.id;
    const [a, b] = [await make("5035550011"), await make("5035550012")];
    const statuses = (
      await Promise.all([a, b].map((id) => call(`/api/v1/customers/${id}`, { method: "PATCH", who: owner, json: { email: "same@example.com" } })))
    ).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });
});

describe("delete requests", () => {
  const add = async (who: Awaited<ReturnType<typeof newOwner>>, first_name: string, phone: string, last_name = "") =>
    ((await (await call("/api/v1/customers", { method: "POST", who, json: { first_name, phone, ...(last_name && { last_name }) } })).json()) as { customer: { id: string } }).customer;

  it("the owner can dismiss a request; another calendar can't", async () => {
    const owner = await newOwner();
    const other = await newOwner();
    const cus = await add(owner, "Dee", "503-555-0199");
    await testEnv.DB.prepare("UPDATE customers SET delete_requested_at = ?, delete_request_appointment_id = 'apt_x' WHERE id = ?").bind(Date.now(), cus.id).run();

    expect((await call(`/api/v1/customers/${cus.id}/dismiss-delete-request`, { method: "POST", who: other })).status).toBe(404);
    const res = await call(`/api/v1/customers/${cus.id}/dismiss-delete-request`, { method: "POST", who: owner });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { delete_requested_at: string | null; delete_request_appointment_id: string | null };
    expect(body.delete_requested_at).toBeNull();
    expect(body.delete_request_appointment_id).toBeNull();
  });

  it("lists customers who asked for deletion first", async () => {
    const owner = await newOwner();
    const older = await add(owner, "Old", "503-555-0101");
    await testEnv.DB.prepare("UPDATE customers SET created_at = created_at - 100000, delete_requested_at = ? WHERE id = ?").bind(Date.now(), older.id).run();
    await add(owner, "New", "503-555-0102");
    const list = ((await (await call("/api/v1/customers", { who: owner })).json()) as { customers: { id: string }[] }).customers;
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(older.id);
  });

  it("finds a customer by full name", async () => {
    const owner = await newOwner();
    const mike = await add(owner, "Mike", "503-555-0103", "Smith");
    const found = ((await (await call("/api/v1/customers?q=mike%20smith", { who: owner })).json()) as { customers: { id: string }[] }).customers;
    expect(found.map((c) => c.id)).toEqual([mike.id]);
  });
});

describe("deleting a customer", () => {
  it("erases the notes on their bookings as well as their contact details", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const booked = await call("/api/v1/appointments", {
      method: "POST", who: owner,
      json: { service_id: serviceId, start: slots[0], customer: { first_name: "Nia", phone: "503-555-0177" }, note: "Gate code 4412" },
    });
    expect(booked.status).toBe(201);
    const { appointment } = (await booked.json()) as { appointment: { id: string; customer: { id: string } } };

    expect((await call(`/api/v1/customers/${appointment.customer.id}`, { method: "DELETE", who: owner })).status).toBe(204);
    const row = await testEnv.DB.prepare("SELECT note, contact_first_name, contact_phone FROM appointments WHERE id = ?").bind(appointment.id).first();
    expect(row).toEqual({ note: "", contact_first_name: "Deleted", contact_phone: null });
  });
});
