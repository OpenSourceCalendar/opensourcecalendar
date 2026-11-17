// Staging only: makes a Stripe test clock and a customer on it, so trial end, renewals and failed payments can be
// fast-forwarded. Prints the customer id; put it on the staging account's billing row (see the plan's Task 14).
// Usage: node scripts/stripe-test-clock.mjs <key-file> <email>
import { readFileSync } from "node:fs";
const [keyFile, email] = process.argv.slice(2);
const key = readFileSync(keyFile, "utf8").match(/^STRIPE_SECRET_KEY=(\S+)$/m)?.[1];
if (!key?.startsWith("sk_test_") && !key?.startsWith("rk_test_")) throw new Error("test keys only");
const post = async (path, body) => {
  const res = await fetch(`https://api.stripe.com${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2026-09-30.endive" }, body: new URLSearchParams(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error?.code}`);
  return data;
};
const clock = await post("/v1/test_helpers/test_clocks", { frozen_time: String(Math.floor(Date.now() / 1000)), name: "billing test" });
const customer = await post("/v1/customers", { email, test_clock: clock.id });
console.log("test clock:", clock.id);
console.log("customer:", customer.id);
