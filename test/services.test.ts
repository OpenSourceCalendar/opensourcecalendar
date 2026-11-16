import { describe, it, expect } from "vitest";
import { call, newOwner } from "./helpers";

type Service = { id: string; name: string; duration_min: number; price_cents: number | null; hidden: boolean; is_call_default: boolean; sort_order: number };

async function add(owner: Awaited<ReturnType<typeof newOwner>>, json: Record<string, unknown>) {
  const res = await call("/api/v1/services", { method: "POST", who: owner, json });
  expect(res.status).toBe(201);
  return (await res.json()) as Service;
}

describe("services", () => {
  it("adds a service with defaults and lists it", async () => {
    const owner = await newOwner();
    const s = await add(owner, { name: "Call with Alex", duration_min: 30 });
    expect(s).toMatchObject({ name: "Call with Alex", duration_min: 30, price_cents: null, hidden: false, is_call_default: false });
    const list = (await (await call("/api/v1/services", { who: owner })).json()) as { services: Service[] };
    expect(list.services.map((x) => x.id)).toEqual([s.id]);
  });

  it("rejects a service without a name or length", async () => {
    const owner = await newOwner();
    expect((await call("/api/v1/services", { method: "POST", who: owner, json: { name: "" } })).status).toBe(400);
  });

  it("edits, hides and keeps one call default", async () => {
    const owner = await newOwner();
    const a = await add(owner, { name: "A", duration_min: 30, is_call_default: true });
    const b = await add(owner, { name: "B", duration_min: 60 });
    const res = await call(`/api/v1/services/${b.id}`, { method: "PATCH", who: owner, json: { is_call_default: true, hidden: true } });
    expect(res.status).toBe(200);
    const list = ((await (await call("/api/v1/services", { who: owner })).json()) as { services: Service[] }).services;
    expect(list.find((x) => x.id === a.id)!.is_call_default).toBe(false);
    expect(list.find((x) => x.id === b.id)).toMatchObject({ is_call_default: true, hidden: true });
  });

  it("reorders and soft-deletes", async () => {
    const owner = await newOwner();
    const a = await add(owner, { name: "A", duration_min: 30 });
    const b = await add(owner, { name: "B", duration_min: 30 });
    expect((await call("/api/v1/services/order", { method: "PUT", who: owner, json: { ids: [b.id, a.id] } })).status).toBe(204);
    let list = ((await (await call("/api/v1/services", { who: owner })).json()) as { services: Service[] }).services;
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await call(`/api/v1/services/${a.id}`, { method: "DELETE", who: owner })).status).toBe(204);
    list = ((await (await call("/api/v1/services", { who: owner })).json()) as { services: Service[] }).services;
    expect(list.map((x) => x.id)).toEqual([b.id]);
  });
});
