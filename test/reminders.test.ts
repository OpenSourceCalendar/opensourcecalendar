import { describe, it, expect } from "vitest";
import { bookableOwner, call } from "./helpers";

describe("reminders", () => {
  it("adds, lists, marks done and deletes, without blocking booking times", async () => {
    const { owner, serviceId, slots, date } = await bookableOwner();
    const res = await call("/api/v1/reminders", { method: "POST", who: owner, json: { at: slots[0], title: "Call back Mike", external_ref: "lead_7" } });
    expect(res.status).toBe(201);
    const r = (await res.json()) as { id: string; at: string; done: boolean };
    expect(r).toMatchObject({ at: slots[0], done: false });

    const open = ((await (await call(`/api/v1/slots?service_id=${serviceId}&date=${date}`, { who: owner })).json()) as { slots: string[] }).slots;
    expect(open).toContain(slots[0]);

    const list = (await (await call(`/api/v1/reminders?from=${date}T00:00:00.000Z&to=${date}T23:59:59.000Z`, { who: owner })).json()) as { reminders: { id: string }[] };
    expect(list.reminders.map((x) => x.id)).toEqual([r.id]);

    const done = await call(`/api/v1/reminders/${r.id}`, { method: "PATCH", who: owner, json: { done: true } });
    expect(((await done.json()) as { done: boolean }).done).toBe(true);
    expect((await call(`/api/v1/reminders/${r.id}`, { method: "DELETE", who: owner })).status).toBe(204);
  });
});
