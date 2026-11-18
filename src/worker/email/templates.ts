// The words and layout of every email. Pure functions: facts in, { subject, text, html } out.
// Every value that came from a person is escaped for HTML and kept to one line in subjects.

export interface EmailFacts {
  /** "" when the owner hasn't set one. */
  businessName: string;
  businessPhone: string;
  /** #rrggbb */
  brandColor: string;
  serviceName: string;
  /** UTC ms */
  start: number;
  end: number;
  /** The reader's time zone: the customer's for customer emails, the business's for owner emails. */
  timeZone: string;
  /** Null on cancellation emails. */
  manageUrl: string | null;
  bookUrl: string;
  /** Null for a White-label client: it has no login yet, so the link would land on our sign-in page. */
  scheduleUrl: string | null;
  locationText: string;
  confirmationMessage: string;
  /** "Powered by" setting: adds "using Open Source Calendar" to the footer. */
  poweredBy: boolean;
  // Owner emails only. Customer emails never show what was typed, so they can't carry a stranger's message.
  cancelReason: string | null;
  customer: { name: string; phone: string | null; email: string | null };
  note: string;
}

export interface EmailBody {
  subject: string;
  text: string;
  html: string;
}

export type CustomerKind = "booked" | "changed" | "cancelled" | "reminder";
export type OwnerKind = "new" | "changed" | "cancelled";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** No line breaks or tabs (they would break a mail header), squeezed and cut to `max`. */
export const oneLine = (s: string, max = 150) =>
  // Cut on whole characters, never through the middle of an emoji.
  Array.from(s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim()).slice(0, max).join("");

const fmt = (ms: number, timeZone: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(ms);
const longDate = (ms: number, tz: string) => fmt(ms, tz, { weekday: "long", month: "long", day: "numeric" });
const shortDate = (ms: number, tz: string) => fmt(ms, tz, { weekday: "short", month: "short", day: "numeric" });
const clock = (ms: number, tz: string) => fmt(ms, tz, { hour: "numeric", minute: "2-digit" });

/** "Eastern Time", falling back to the zone's name. */
function zoneName(ms: number, tz: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longGeneric" })
      .formatToParts(ms)
      .find((p) => p.type === "timeZoneName")?.value;
    if (name && !/^GMT/.test(name)) return name;
  } catch {
    /* unknown zone: fall through */
  }
  return tz.replace(/_/g, " ");
}

// Readable text on the brand color (the same rule the booking page uses).
function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
function brandColors(color: string): { brand: string; onBrand: string } {
  const brand = /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#334155";
  const lum = luminance(brand);
  return { brand, onBrand: contrast(lum, 0.96) >= contrast(lum, 0.012) ? "#fbfbfc" : "#14161a" };
}

/** Fill in [Business Name] [Date] [Time] [Service] in one pass, so a fill-in's value is never filled in again. */
function fillIn(message: string, f: EmailFacts): string {
  const values: Record<string, string> = {
    "Business Name": f.businessName || "us",
    Date: longDate(f.start, f.timeZone),
    Time: clock(f.start, f.timeZone),
    Service: f.serviceName,
  };
  return message.replace(/\[(Business Name|Date|Time|Service)\]/g, (_, key: string) => values[key]);
}

interface Layout {
  heading: string;
  paragraphs: string[];
  details: [string, string][];
  button?: { label: string; url: string };
  links?: { label: string; url: string }[];
  smallPrint?: string;
}

function render(f: EmailFacts, l: Layout): { text: string; html: string } {
  const name = f.businessName || "Open Source Calendar";
  const footer = `Sent by ${name}${f.poweredBy ? " using Open Source Calendar (opensourcecalendar.com)" : ""}.`;

  const text = [
    l.heading,
    "",
    ...l.paragraphs.flatMap((p) => [p, ""]),
    ...l.details.map(([k, v]) => `${k}: ${v}`),
    "",
    ...(l.button ? [`${l.button.label}:`, l.button.url, ""] : []),
    ...(l.links ?? []).flatMap((x) => [`${x.label}:`, x.url, ""]),
    ...(l.smallPrint ? [l.smallPrint, ""] : []),
    ...(f.businessPhone ? [`${name}: ${f.businessPhone}`] : []),
    footer,
  ].join("\n");

  const { brand, onBrand } = brandColors(f.brandColor);
  const ink = "#191b1f";
  const muted = "#5b616b";
  const cell = `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`;
  const p = (t: string) => `<p style="${cell}margin:0 0 14px;font-size:16px;line-height:1.5;color:${ink};">${esc(t)}</p>`;
  const rows = l.details
    .map(
      ([k, v]) =>
        `<tr><td style="${cell}padding:6px 12px 6px 0;font-size:14px;color:${muted};vertical-align:top;white-space:nowrap;">${esc(k)}</td>` +
        `<td style="${cell}padding:6px 0;font-size:15px;color:${ink};font-weight:600;">${esc(v)}</td></tr>`,
    )
    .join("");
  const button = l.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;"><tr><td style="background:${brand};border-radius:8px;">` +
      `<a href="${esc(l.button.url)}" style="${cell}display:inline-block;padding:12px 22px;font-size:16px;font-weight:600;color:${onBrand};text-decoration:none;">${esc(l.button.label)}</a>` +
      `</td></tr></table>`
    : "";
  const links = (l.links ?? [])
    .map((x) => `<p style="${cell}margin:0 0 10px;font-size:15px;"><a href="${esc(x.url)}" style="color:${brand};">${esc(x.label)}</a></p>`)
    .join("");
  const small = l.smallPrint ? `<p style="${cell}margin:0 0 10px;font-size:13px;color:${muted};">${esc(l.smallPrint)}</p>` : "";
  const phone = f.businessPhone ? `<p style="${cell}margin:0 0 6px;font-size:14px;color:${muted};">${esc(name)}: ${esc(f.businessPhone)}</p>` : "";

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:#f3f3f1;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f3f1;"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">` +
    `<tr><td style="${cell}background:${brand};color:${onBrand};padding:18px 24px;font-size:18px;font-weight:700;">${esc(name)}</td></tr>` +
    `<tr><td style="padding:24px;background:#ffffff;">` +
    `<h1 style="${cell}margin:0 0 14px;font-size:21px;line-height:1.3;color:${ink};">${esc(l.heading)}</h1>` +
    l.paragraphs.map(p).join("") +
    (rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;">${rows}</table>` : "") +
    button +
    links +
    small +
    `</td></tr>` +
    `<tr><td style="padding:14px 24px 20px;background:#ffffff;border-top:1px solid #e3e4e6;">${phone}` +
    `<p style="${cell}margin:0;font-size:13px;color:${muted};">${esc(footer)}</p></td></tr>` +
    `</table></td></tr></table></body></html>`;

  return { text, html };
}

function when(f: EmailFacts): [string, string][] {
  const rows: [string, string][] = [
    ["Service", f.serviceName],
    ["Date", longDate(f.start, f.timeZone)],
    ["Time", `${clock(f.start, f.timeZone)} – ${clock(f.end, f.timeZone)} (${zoneName(f.start, f.timeZone)})`],
  ];
  if (f.locationText) rows.push(["Where", f.locationText]);
  return rows;
}

const withBusiness = (f: EmailFacts) => (f.businessName ? ` with ${oneLine(f.businessName, 80)}` : "");

export function customerEmail(kind: CustomerKind, f: EmailFacts): EmailBody {
  const change = f.manageUrl ? { label: "Change or cancel", url: f.manageUrl } : undefined;
  let subject: string;
  let layout: Layout;
  switch (kind) {
    case "booked":
      subject = `Your appointment${withBusiness(f)} is confirmed`;
      layout = { heading: "You're booked", paragraphs: [fillIn(f.confirmationMessage, f)], details: when(f), button: change };
      break;
    case "changed":
      subject = `Your appointment${withBusiness(f)} has changed`;
      layout = { heading: "Your appointment has changed", paragraphs: ["Here are the new details."], details: when(f), button: change };
      break;
    case "cancelled":
      subject = `Your appointment${withBusiness(f)} is cancelled`;
      layout = {
        heading: "Your appointment is cancelled",
        paragraphs: ["This appointment won't go ahead."],
        details: when(f),
        links: [{ label: "Book again", url: f.bookUrl }],
      };
      break;
    case "reminder":
      subject = `Reminder: ${f.serviceName} on ${longDate(f.start, f.timeZone)} at ${clock(f.start, f.timeZone)}`;
      layout = { heading: "See you soon", paragraphs: ["This is a reminder of your appointment."], details: when(f), button: change };
      break;
  }
  return { subject: oneLine(subject), ...render(f, layout) };
}

export function ownerEmail(kind: OwnerKind, f: EmailFacts): EmailBody {
  const who = f.customer.name || "A customer";
  const at = `${shortDate(f.start, f.timeZone)}, ${clock(f.start, f.timeZone)}`;
  const subject = { new: "New booking", changed: "Booking changed", cancelled: "Booking cancelled" }[kind];
  const heading = {
    new: `${who} booked ${f.serviceName}`,
    changed: `${who} moved their appointment`,
    cancelled: `${who} cancelled`,
  }[kind];
  const details: [string, string][] = [...when(f), ["Customer", who]];
  if (f.customer.phone) details.push(["Phone", f.customer.phone]);
  if (f.customer.email) details.push(["Email", f.customer.email]);
  if (f.note) details.push(["Note", f.note]);
  if (kind === "cancelled" && f.cancelReason) details.push(["Reason", f.cancelReason]);
  return {
    subject: oneLine(`${subject}: ${who}, ${at}`),
    ...render(f, {
      heading,
      paragraphs: kind === "changed" ? ["The new time is below."] : [],
      details,
      ...(f.scheduleUrl
        ? { button: { label: "Open your schedule", url: f.scheduleUrl }, smallPrint: "If that asks you to sign in, open the calendar from your app." }
        : {}),
    }),
  };
}
