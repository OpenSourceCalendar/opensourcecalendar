import type { BillingInfo } from "./api";

/** Top-of-screen notices: a failed payment, a paused client, or the Free email limit reached this month. */
export function Banners({
  billing,
  client,
  paused,
  clientUser,
  navigate,
}: {
  billing: BillingInfo | null;
  client: boolean;
  paused: boolean;
  /** Signed in as a White-label client (not the agency). */
  clientUser: boolean;
  navigate: (path: string) => void;
}) {
  // A client's own sign-in: no plans or prices, just who to ask.
  if (clientUser) return paused ? <div className="banner" role="status">Online booking is paused. Please contact your provider.</div> : null;
  if (!billing?.enabled) return null;
  const toPlan = (text: string) => (
    <button type="button" className="link" onClick={() => navigate("/admin/plan")}>
      {text}
    </button>
  );
  if (billing.status === "past_due") {
    return (
      <div className="banner banner-danger" role="alert">
        Your payment failed. {toPlan("Update your card")}
      </div>
    );
  }
  if (paused) {
    return (
      <div className="banner" role="status">
        Paused — online booking is off. {toPlan("Subscribe to White-label")} to turn it back on.
      </div>
    );
  }
  if (!client && !billing.paid && billing.monthly_limit !== null && billing.bookings_this_month >= billing.monthly_limit) {
    return (
      <div className="banner" role="status">
        You've used your {billing.monthly_limit} free bookings this month. New bookings won't send emails until the 1st. {toPlan("Upgrade to Pro")}
      </div>
    );
  }
  return null;
}
