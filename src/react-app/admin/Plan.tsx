import { useEffect, useState } from "react";
import { adminApi, adminErrorText, type BillingInfo } from "./api";

const PLANS = [
  { id: "pro" as const, name: "Pro", month: 10, year: 100, items: ["Unlimited staff calendars", "Google Calendar sync", "Reminder emails", "No footer"] },
  { id: "white_label" as const, name: "White-label", month: 50, year: 500, items: ["Unlimited client businesses", "Your agency's brand only", "An address per client", "Everything in Pro"] },
];
const NAME = { free: "Free", pro: "Pro", white_label: "White-label" } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function Plan({ billing, reload }: { billing: Extract<BillingInfo, { enabled: true }>; reload: () => void }) {
  const [interval, setInterval_] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const justPaid = new URLSearchParams(window.location.search).get("checkout") === "done";
  // Grace counts as paid, so a resubscribe from the grace month also waits for the webhook.
  const waiting = justPaid && (!billing.paid || !!billing.grace_until);

  // Back from Stripe: the webhook usually lands within seconds; check every 3 s for up to a minute.
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = window.setInterval(() => (++n > 20 ? window.clearInterval(t) : reload()), 3000);
    return () => window.clearInterval(t);
  }, [waiting, reload]);

  // Stripe pages open in this tab; the button stays busy until the browser leaves.
  async function go(action: () => Promise<{ url: string }>, key: string) {
    setBusy(key);
    setError("");
    try {
      window.location.href = (await action()).url;
    } catch (e) {
      setError(adminErrorText(e));
      setBusy(null);
    }
  }

  // The Monthly/Yearly switch and the two plan cards, shown on Free and during the White-label grace month.
  const planCards = (
    <>
      <div>
        <div className="segmented" role="group" aria-label="Billing period">
          <button type="button" aria-pressed={interval === "month"} onClick={() => setInterval_("month")}>
            Monthly
          </button>
          <button type="button" aria-pressed={interval === "year"} onClick={() => setInterval_("year")}>
            Yearly (2 months free)
          </button>
        </div>
      </div>
      <div className="plan-cards">
        {PLANS.map((p) => (
          <section className="card" key={p.id} aria-labelledby={`plan-${p.id}`}>
            <h2 className="card-title" id={`plan-${p.id}`}>
              {p.name}
            </h2>
            <p className="plan-price">
              ${interval === "month" ? p.month : p.year}
              <span className="muted small"> / {interval}</span>
            </p>
            <ul className="gc-benefits">
              {p.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => go(() => adminApi.checkout(p.id, interval), p.id)}>
              {busy === p.id ? "Opening…" : billing.trial_available ? "Start 14-day free trial" : "Subscribe"}
            </button>
          </section>
        ))}
      </div>
    </>
  );

  return (
    <>
      <header className="admin-band">
        <h1 className="admin-title">Plan</h1>
      </header>
      {waiting && (
        <p className="lede" role="status">
          You're all set. Your plan turns on in a moment…
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {billing.grace_until ? (
        <>
          <section className="card plan-now">
            <h2 className="card-title">White-label has ended</h2>
            <p>Your clients' calendars keep running until {day(billing.grace_until)}. Subscribe to keep everything on.</p>
          </section>
          {planCards}
        </>
      ) : billing.paid ? (
        <section className="card plan-now">
          <h2 className="card-title">
            {NAME[billing.plan]}
            {billing.interval ? ` · ${billing.interval === "year" ? "Yearly" : "Monthly"}` : ""}
          </h2>
          {billing.status === "trialing" && billing.trial_end && (
            <p>
              {billing.cancel_at_period_end
                ? `Trial ends ${day(billing.trial_end)}. You won't be charged.`
                : `Free trial until ${day(billing.trial_end)}.`}
            </p>
          )}
          {(billing.status === "active" || billing.status === "past_due") && billing.current_period_end && (
            <p>
              {billing.cancel_at_period_end ? "Ends" : "Renews"} {day(billing.current_period_end)}.
            </p>
          )}
          {billing.has_customer && (
            <button type="button" className="btn btn-secondary btn-auto" disabled={busy !== null} onClick={() => go(adminApi.billingPortal, "portal")}>
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
          )}
        </section>
      ) : (
        <>
          <section className="card plan-now">
            <h2 className="card-title">Free plan</h2>
            <p>
              Bookings this month: {billing.bookings_this_month} of {billing.monthly_limit} with emails.
            </p>
            <p className="muted small">Free includes email confirmations and the "Powered by" footer. Reminders and Google Calendar sync come with Pro.</p>
          </section>
          {planCards}
          {billing.has_customer && (
            <p>
              <button type="button" className="link muted" disabled={busy !== null} onClick={() => go(adminApi.billingPortal, "portal")}>
                {busy === "portal" ? "Opening…" : "Billing history"}
              </button>
            </p>
          )}
        </>
      )}
    </>
  );
}
