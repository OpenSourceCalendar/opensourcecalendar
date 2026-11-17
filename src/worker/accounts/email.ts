import type { OutgoingEmail } from "../email/outbox";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The one-time sign-in link email, for a log-in or for finishing a sign-up. */
export function signInEmail(from: string, to: string, link: string, signup: boolean): OutgoingEmail {
  const action = signup ? "finish creating your account" : "log in";
  const text = `Use this link to ${action} on Open Source Calendar:\n\n${link}\n\nIt works once, for 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.\n`;
  const html = `<p>Use this button to ${action} on Open Source Calendar.</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#1e40af;color:#ffffff;text-decoration:none;font-weight:700">${signup ? "Finish signing up" : "Log in"}</a></p>
<p>It works once, for 15 minutes. If you didn't ask for this, you can ignore this email.</p>`;
  return { to, from: { email: from, name: "Open Source Calendar" }, subject: "Your Open Source Calendar sign-in link", text, html };
}
