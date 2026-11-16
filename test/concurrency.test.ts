import { describe, it, expect } from "vitest";
import { bookableOwner, call } from "./helpers";

describe("no double booking under concurrency", () => {
  it("five people booking the same time: exactly one wins", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        call("/api/v1/appointments", {
          method: "POST", who: owner,
          json: { service_id: serviceId, start: slots[0], customer: { first_name: `P${i}`, phone: `50355502${i}0` } },
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });

  it("two overlapping times at once (09:00 and 09:15): only one wins", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const results = await Promise.all(
      [slots[0], slots[1]].map((start, i) =>
        call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start, customer: { first_name: "X", phone: `50355503${i}0` } } }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("two appointments moving to the same time: only one wins", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    const mk = async (start: string, phone: string) =>
      ((await (await call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start, customer: { first_name: "M", phone } } })).json()) as { appointment: { id: string } }).appointment.id;
    const [a, b] = [await mk(slots[0], "5035550401"), await mk(slots[4], "5035550402")];
    const results = await Promise.all([a, b].map((id) => call(`/api/v1/appointments/${id}`, { method: "PATCH", who: owner, json: { start: slots[8] } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("the daily limit holds when two different times are booked at once", async () => {
    const { owner, serviceId, slots } = await bookableOwner();
    await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { max_per_day: 1 } } });
    const results = await Promise.all(
      [slots[0], slots[8]].map((start, i) =>
        call("/api/v1/appointments", { method: "POST", who: owner, json: { service_id: serviceId, start, customer: { first_name: "D", phone: `50355505${i}0` } } }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});
