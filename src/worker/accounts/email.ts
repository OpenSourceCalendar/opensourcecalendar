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

const button = (link: string, label: string) =>
  `<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#1e40af;color:#ffffff;text-decoration:none;font-weight:700">${esc(label)}</a></p>`;

/** A client's sign-in link: the client's name only, never the product's ("" if its calendar is gone: neutral wording). */
export function clientSignInEmail(from: string, to: string, link: string, brand: string): OutgoingEmail {
  const where = brand ? `your booking calendar for ${brand}` : "your booking calendar";
  const text = `Use this link to log in to ${where}:\n\n${link}\n\nIt works once, for 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.\n`;
  const html = `<p>Use this button to log in to ${esc(where)}.</p>${button(link, "Log in")}<p>It works once, for 15 minutes. If you didn't ask for this, you can ignore this email.</p>`;
  return { to, from: { email: from, name: brand || "Your booking calendar" }, subject: brand ? `Your sign-in link for ${brand}` : "Your sign-in link", text, html };
}

/** The invite a White-label agency sends from the Clients page, in the client's name. */
export function clientInviteEmail(from: string, to: string, link: string, brand: string): OutgoingEmail {
  const text = `Your booking calendar for ${brand} is ready. Set your password here:\n\n${link}\n\nThe link works once, for 7 days.\n`;
  const html = `<p>Your booking calendar for ${esc(brand)} is ready.</p>${button(link, "Set your password")}<p>The link works once, for 7 days.</p>`;
  return { to, from: { email: from, name: brand }, subject: "Your booking calendar is ready — set your password", text, html };
}

/**
 * After a password is set or changed. `brand` = the client's name for client sign-ins ("" if its calendar is gone:
 * neutral wording, never the product's name), null for everyone else.
 */
export function passwordSetEmail(from: string, to: string, changed: boolean, brand: string | null): OutgoingEmail {
  const what = changed ? "changed" : "set";
  const client = brand !== null;
  const help = client
    ? "If this wasn't you, use “Email me a sign-in link” on your sign-in page, change your password, and tell your provider."
    : "If this wasn't you, use “Email me a sign-in link” on the log-in page, change your password, and contact support@opensourcecalendar.com.";
  const where = !client ? "your Open Source Calendar account" : brand ? `your booking calendar for ${brand}` : "your booking calendar";
  const text = `The password for ${where} was just ${what}. Other devices were signed out.\n\n${help}\n`;
  const html = `<p>The password for ${esc(where)} was just ${what}. Other devices were signed out.</p><p>${esc(help)}</p>`;
  return { to, from: { email: from, name: !client ? "Open Source Calendar" : brand || "Your booking calendar" }, subject: `Your password was ${what}`, text, html };
}
