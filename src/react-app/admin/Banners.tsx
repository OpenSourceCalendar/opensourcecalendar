import type { BillingInfo } from "./api";

/** Top-of-screen notices: a failed payment, or the Free email limit reached this month. */
export function Banners({ billing, navigate }: { billing: BillingInfo | null; navigate: (path: string) => void }) {
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
  if (!billing.paid && billing.monthly_limit !== null && billing.bookings_this_month >= billing.monthly_limit) {
    return (
      <div className="banner" role="status">
        You've used your {billing.monthly_limit} free bookings this month. New bookings won't send emails until the 1st. {toPlan("Upgrade to Pro")}
      </div>
    );
  }
  return null;
}
