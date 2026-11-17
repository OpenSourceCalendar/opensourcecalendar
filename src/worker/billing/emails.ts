import { publicBase } from "../accounts/config";
import { emailFrom, type Built } from "../email/send";
import type { EmailKind, EmailPayload } from "../email/outbox";
import type { Bindings } from "../types";
import { userEmail } from "./store";

/** A plain notice to the operator (disputes, duplicate subscriptions). Sent at once; throws if sending fails. */
export async function sendOperatorEmail(env: Bindings, subject: string, text: string): Promise<void> {
  const from = emailFrom(env);
  if (!from || !env.OPERATOR_EMAIL || !env.EMAIL) {
    console.error(JSON.stringify({ event: "operator_email_not_configured", subject }));
    return;
  }
  await env.EMAIL.send({ to: env.OPERATOR_EMAIL, from: { email: from, name: "Open Source Calendar" }, subject, text, html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` });
}

const longDay = (ms: number, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric" }).format(ms);
const monthName = (ym: string) => new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(Date.parse(`${ym}-01T12:00:00Z`));
const nextMonthFirst = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(Date.UTC(y, m, 1, 12)) + " 1";
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (paras: string[], link: { label: string; url: string }) =>
  `${paras.map((p) => `<p>${esc(p)}</p>`).join("")}<p><a href="${esc(link.url)}">${esc(link.label)}</a></p><p style="color:#666">Open Source Calendar</p>`;

/** Plan emails to the account owner. Built fresh at send time like every other email. */
export async function buildAccountEmail(env: Bindings, from: string, kind: EmailKind, p: EmailPayload, timeZone: string): Promise<Built> {
  if (!p.user_id) return { skip: "no_account" };
  const to = await userEmail(env.DB, p.user_id);
  if (!to) return { skip: "no_account" };
  const plan = `${publicBase(env)}/admin/plan`;
  let subject: string;
  let paras: string[];
  let label = "Open your plan";
  if (kind === "email.account.limit") {
    const month = p.month ?? "";
    subject = `You've used your 10 free bookings for ${monthName(month)}`;
    paras = [
      `Your calendar has had 10 bookings this month, the Free plan's limit for emails.`,
      `New bookings still come in and show in your schedule, but no emails go out for them until ${nextMonthFirst(month)}.`,
      `Pro sends every email, reminders included, from $10 a month.`,
    ];
    label = "Upgrade to Pro";
  } else if (kind === "email.account.grace_start") {
    subject = "Is everything okay?";
    paras = [
      `Hi, we noticed your White-label plan stopped. Is everything okay?`,
      `Your clients' calendars keep running as normal until ${longDay(p.until ?? 0, timeZone)}, so nothing changes for them yet.`,
      `If something's wrong or you need a hand, just reply to this email.`,
    ];
  } else if (kind === "email.account.grace_end") {
    subject = `Client calendars pause on ${longDay(p.until ?? 0, timeZone)}`;
    paras = [
      `A reminder: your White-label plan ended, and your clients' calendars pause on ${longDay(p.until ?? 0, timeZone)}.`,
      `Subscribing again keeps everything running. Questions? Just reply.`,
    ];
    label = "Subscribe again";
  } else return { skip: "unknown_kind" };
  const text = `${paras.join("\n\n")}\n\n${label}: ${plan}\n\nOpen Source Calendar`;
  return {
    message: {
      to, from: { email: from, name: "Open Source Calendar" }, subject, text, html: html(paras, { label, url: plan }),
      headers: { "Auto-Submitted": "auto-generated" },
      ...(env.OPERATOR_EMAIL ? { replyTo: env.OPERATOR_EMAIL } : {}),
    },
  };
}
