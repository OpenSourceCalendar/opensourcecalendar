import { describe, it, expect } from "vitest";
import { call, newOwner } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Owner = Awaited<ReturnType<typeof newOwner>>;
const upload = (who: Owner, kind: string, body: Uint8Array, type = "image/png") =>
  call(`/api/v1/images/${kind}`, { method: "PUT", who, body, headers: { "Content-Type": type } });
const branding = async (who: Owner) =>
  ((await (await call("/api/v1/calendar", { who })).json()) as { branding: { logo_key: string | null; hero_key: string | null } }).branding;

describe("logo and hero uploads", () => {
  it("stores a logo, serves it publicly and shows it on the booking page", async () => {
    const owner = await newOwner();
    const res = await upload(owner, "logo", PNG);
    expect(res.status).toBe(200);
    const { key, url } = (await res.json()) as { key: string; url: string };
    expect(key).toMatch(/^cal\/[A-Za-z0-9_]+\/logo-[A-Za-z0-9_-]+\.png$/);
    expect((await branding(owner)).logo_key).toBe(key);
    const mine = (await (await call("/api/v1/calendar", { who: owner })).json()) as { branding: { logo_url: string } };
    expect(mine.branding.logo_url).toBe(url);

    const img = await call(url);
    expect(img.status).toBe(200);
    expect(img.headers.get("Content-Type")).toBe("image/png");
    expect(img.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);

    const pub = (await (await call(`/api/public/${owner.slug}`)).json()) as { branding: Record<string, unknown> };
    expect(pub.branding.logo_url).toBe(url);
    expect(pub.branding.hero_url).toBeNull();
    expect(pub.branding).not.toHaveProperty("logo_key");
  });

  it("goes by the file's bytes, not the Content-Type header", async () => {
    const owner = await newOwner();
    expect((await upload(owner, "logo", SVG, "image/png")).status).toBe(415);
    expect((await upload(owner, "logo", new Uint8Array(0))).status).toBe(415);
    const jpg = await upload(owner, "hero", JPG, "text/plain");
    expect(jpg.status).toBe(200);
    expect(((await jpg.json()) as { key: string }).key).toMatch(/hero-.*\.jpg$/);
  });

  it("refuses files over the limit and unknown kinds", async () => {
    const owner = await newOwner();
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload(owner, "logo", big)).status).toBe(413);
    expect((await upload(owner, "banner", PNG)).status).toBe(404);
    expect((await upload(owner, "constructor", PNG)).status).toBe(404); // not an own key of the kinds table
  });

  it("replacing or removing a logo deletes the old file", async () => {
    const owner = await newOwner();
    const first = (await (await upload(owner, "logo", PNG)).json()) as { url: string };
    const second = (await (await upload(owner, "logo", JPG)).json()) as { url: string };
    expect((await call(first.url)).status).toBe(404);
    const still = await call(second.url);
    expect(still.status).toBe(200);
    await still.arrayBuffer(); // always read an image body so the R2 stream is closed
    expect((await call("/api/v1/images/logo", { method: "DELETE", who: owner })).status).toBe(204);
    expect((await call(second.url)).status).toBe(404);
    expect((await branding(owner)).logo_key).toBeNull();
  });

  it("can't point a calendar at another calendar's file, or at a made-up key", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const { key } = (await (await upload(a, "logo", PNG)).json()) as { key: string };
    const patch = await call("/api/v1/calendar", { method: "PATCH", who: b, json: { branding: { logo_key: key, tagline: "hi" } } });
    expect(patch.status).toBe(200);
    expect((await branding(b)).logo_key).toBeNull(); // ignored; the tagline still saved
    // Encoded so it reaches the handler as "cal/x/../y"; the anchored key pattern refuses it.
    expect((await call("/api/public/images/cal%2Fx%2F..%2Fy")).status).toBe(404);
    expect((await call("/api/public/images/not-a-key")).status).toBe(404);
  });

  it("saving other settings keeps the uploaded image", async () => {
    const owner = await newOwner();
    const { key } = (await (await upload(owner, "logo", PNG)).json()) as { key: string };
    expect((await call("/api/v1/calendar", { method: "PATCH", who: owner, json: { rules: { buffer_min: 15 }, branding: { tagline: "x" } } })).status).toBe(200);
    expect((await branding(owner)).logo_key).toBe(key);
  });

  it("needs sign-in to upload", async () => {
    expect((await call("/api/v1/images/logo", { method: "PUT", body: PNG })).status).toBe(401);
  });
});
