import { emailFrom } from "../email/send";
import type { Bindings } from "../types";

/** A plain notice to the operator (disputes, duplicate subscriptions). Sent at once; throws if sending fails. */
export async function sendOperatorEmail(env: Bindings, subject: string, text: string): Promise<void> {
  const from = emailFrom(env);
  if (!from || !env.OPERATOR_EMAIL || !env.EMAIL) {
    console.error(JSON.stringify({ event: "operator_email_not_configured", subject }));
    return;
  }
  await env.EMAIL.send({ to: env.OPERATOR_EMAIL, from: { email: from, name: "Open Source Calendar" }, subject, text, html: `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` });
}
