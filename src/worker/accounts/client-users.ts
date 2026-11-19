// White-label clients' own sign-ins: users rows with client_calendar_id set. Invites, removal and the client's look
// on sign-in pages and emails.
import { imageUrl } from "../lib/image-url"; // not routes/images: that imports auth.ts (cycle)
import { parseBranding } from "../settings";

export type ClientBrand = { slug: string; name: string; logo_url: string | null; color: string; style: string };

/** How a client's sign-in pages and emails look: its business name, logo and colours. Null if the calendar is gone. */
export async function clientBrand(db: D1Database, calendarId: string): Promise<ClientBrand | null> {
  const cal = await db.prepare("SELECT slug, branding FROM calendars WHERE id = ?").bind(calendarId).first<{ slug: string; branding: string }>();
  if (!cal) return null;
  const b = parseBranding(cal.branding);
  return { slug: cal.slug, name: b.business_name.replace(/\s+/g, " ").trim().slice(0, 80) || "Your booking calendar", logo_url: imageUrl(b.logo_key), color: b.color, style: b.style };
}
