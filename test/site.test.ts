import { beforeEach, describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { app } from "../src/worker/index";

// The website is on in production (MARKETING_SITE = "on"); off is what a self-hosted copy gets.
const siteOn = { ...env, MARKETING_SITE: "on" };
const post = (body: Record<string, string>) =>
  app.request("/api/waitlist", { method: "POST", body: new URLSearchParams(body) }, siteOn);

async function waitlist() {
  return (await env.DB.prepare("SELECT email FROM waitlist ORDER BY email").all<{ email: string }>()).results.map((r) => r.email);
}

describe("website pages", () => {
  it.each([
    ["/", "The booking app you can own for free."],
    ["/privacy", "Limited Use requirements"],
    ["/terms", "State of Oregon"],
  ])("%s is a plain HTML page", async (path, text) => {
    const res = await app.request(path, {}, siteOn);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(text);
    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
  });

  it("shows the waitlist result only for known states", async () => {
    expect(await (await app.request("/?waitlist=joined", {}, siteOn)).text()).toContain("You’re on the list");
    expect(await (await app.request("/?waitlist=bad", {}, siteOn)).text()).toContain("doesn’t look right");
    const other = await (await app.request("/?waitlist=<script>", {}, siteOn)).text();
    expect(other).not.toContain("<script>");
    expect(other).not.toContain('role="status"');
  });

  it("sends www to the bare domain", async () => {
    const res = await app.request("https://www.opensourcecalendar.com/privacy?x=1", {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://opensourcecalendar.com/privacy?x=1");
  });
});

describe("waitlist form", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM waitlist").run();
  });

  it("stores the email once, lowercased", async () => {
    const res = await post({ email: "  Owner@Example.COM " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/?waitlist=joined#waitlist");
    await post({ email: "owner@example.com" });
    expect(await waitlist()).toEqual(["owner@example.com"]);
  });

  it("rejects a bad address without storing it", async () => {
    const res = await post({ email: "not-an-email" });
    expect(res.headers.get("location")).toBe("/?waitlist=bad#waitlist");
    expect(await waitlist()).toEqual([]);
  });

  it("pretends to accept a bot that fills the hidden field", async () => {
    const res = await post({ email: "bot@example.com", website: "http://spam" });
    expect(res.headers.get("location")).toBe("/?waitlist=joined#waitlist");
    expect(await waitlist()).toEqual([]);
  });
});

describe("search engine files", () => {
  it("lists the website pages when the website is on", async () => {
    const robots = await (await app.request("/robots.txt", {}, siteOn)).text();
    expect(robots).toContain("Disallow: /m/");
    expect(robots).toContain("Sitemap: https://opensourcecalendar.com/sitemap.xml");
    const map = await app.request("/sitemap.xml", {}, siteOn);
    expect(map.headers.get("content-type")).toContain("application/xml");
    expect(await map.text()).toContain("<loc>https://opensourcecalendar.com/privacy</loc>");
  });
});

describe("self-hosted copy (website off)", () => {
  it("shows a plain front page with nothing of ours", async () => {
    const body = await (await app.request("/", {}, env)).text();
    expect(body).toContain("use the link the business gave you");
    expect(body).toContain('content="noindex"');
    expect(body).not.toContain("Open Source Calendar");
  });

  it("has no privacy, terms, sitemap or waitlist of ours", async () => {
    for (const path of ["/privacy", "/terms", "/sitemap.xml"]) expect((await app.request(path, {}, env)).status).toBe(404);
    const res = await app.request("/api/waitlist", { method: "POST", body: new URLSearchParams({ email: "a@example.com" }) }, env);
    expect(res.status).toBe(404);
    expect(await (await app.request("/robots.txt", {}, env)).text()).not.toContain("Sitemap");
  });
});
