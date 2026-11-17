// Creates (or finds) the Stripe products, prices, billing portal configuration and webhook endpoint.
// Usage: node scripts/stripe-setup.mjs <key-file> <webhook-url>
// <key-file> has a line STRIPE_SECRET_KEY=sk_... (the full secret key; the Worker gets a restricted key in live).
// Prints price ids and the webhook endpoint id. The webhook signing secret is written to <key-file>.webhook, never printed.
import { readFileSync, writeFileSync } from "node:fs";

const [keyFile, webhookUrl] = process.argv.slice(2);
if (!keyFile || !webhookUrl) throw new Error("usage: node scripts/stripe-setup.mjs <key-file> <webhook-url>");
const key = readFileSync(keyFile, "utf8").match(/^STRIPE_SECRET_KEY=(\S+)$/m)?.[1];
if (!key) throw new Error("no STRIPE_SECRET_KEY line in the key file");
const VERSION = "2026-09-30.endive";

const enc = (params, prefix = "") => Object.entries(params).flatMap(([k, v]) => {
  const name = prefix ? `${prefix}[${k}]` : k;
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.flatMap((x, i) => (typeof x === "object" ? enc(x, `${name}[${i}]`) : [`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(x)}`]));
  if (typeof v === "object") return enc(v, name);
  return [`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`];
});
async function api(method, path, params = {}) {
  const qs = enc(params).join("&");
  const res = await fetch(`https://api.stripe.com${path}${method === "GET" && qs ? `?${qs}` : ""}`, {
    method, headers: { Authorization: `Bearer ${key}`, "Stripe-Version": VERSION, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? qs : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error?.code ?? res.status} ${data.error?.message ?? ""}`);
  return data;
}

const PLANS = [
  { lookup: "pro", name: "Open Source Calendar Pro", prices: { month: 1000, year: 10000 } },
  { lookup: "white_label", name: "Open Source Calendar White-label", prices: { month: 5000, year: 50000 } },
];
const out = {};
const priceProduct = {};
for (const p of PLANS) {
  const found = await api("GET", "/v1/prices", { lookup_keys: [`${p.lookup}_month`, `${p.lookup}_year`], limit: 10 });
  let product = found.data[0]?.product;
  if (!product) product = (await api("POST", "/v1/products", { name: p.name, tax_code: "txcd_10103001", metadata: { plan: p.lookup } })).id;
  for (const [interval, amount] of Object.entries(p.prices)) {
    const lookup = `${p.lookup}_${interval}`;
    let price = found.data.find((x) => x.lookup_key === lookup);
    if (!price) price = await api("POST", "/v1/prices", { product, currency: "usd", unit_amount: amount, tax_behavior: "exclusive", lookup_key: lookup, recurring: { interval } });
    out[lookup] = price.id;
    priceProduct[price.id] = typeof price.product === "string" ? price.product : price.product.id;
  }
}
console.log("STRIPE_PRICE_PRO_MONTH =", out.pro_month);
console.log("STRIPE_PRICE_PRO_YEAR  =", out.pro_year);
console.log("STRIPE_PRICE_WL_MONTH  =", out.white_label_month);
console.log("STRIPE_PRICE_WL_YEAR   =", out.white_label_year);

const prodIds = [...new Set(Object.values(priceProduct))];
// Update Stripe's default portal configuration (portal sessions without a `configuration` use it), so reruns don't pile up new ones.
const defaults = await api("GET", "/v1/billing_portal/configurations", { is_default: true, limit: 1 });
const portalPath = defaults.data[0] ? `/v1/billing_portal/configurations/${defaults.data[0].id}` : "/v1/billing_portal/configurations";
await api("POST", portalPath, {
  business_profile: { headline: "Open Source Calendar billing" },
  features: {
    customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: {
      enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations",
      products: prodIds.map((product) => ({ product, prices: Object.values(out).filter((id) => priceProduct[id] === product) })),
    },
  },
  default_return_url: webhookUrl.replace(/\/api\/billing\/webhook$/, "/admin/plan"),
});
console.log(defaults.data[0] ? "Default billing portal configuration updated."
  : "WARNING: a new portal configuration was created but it is NOT the default. Set it as default in Dashboard → Settings → Billing → Customer portal.");

const hooks = await api("GET", "/v1/webhook_endpoints", { limit: 100 });
if (hooks.data.some((h) => h.url === webhookUrl)) {
  console.log("Webhook endpoint already exists for", webhookUrl, "(secret not re-shown; roll it in the Dashboard if lost)");
} else {
  const hook = await api("POST", "/v1/webhook_endpoints", {
    url: webhookUrl, api_version: VERSION,
    enabled_events: ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
      "customer.subscription.trial_will_end", "invoice.paid", "invoice.payment_failed", "charge.dispute.created"],
  });
  writeFileSync(`${keyFile}.webhook`, `STRIPE_WEBHOOK_SECRET=${hook.secret}\n`, { mode: 0o600 });
  console.log("Webhook endpoint", hook.id, "created; signing secret saved next to the key file (.webhook).");
}
