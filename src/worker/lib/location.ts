/** Where a service happens, in words: the label, then the owner's text ("At the business · 12 Main St"). */
export function locationText(service: { location_type: string; location_text: string } | null, forOwner = false): string {
  if (!service) return "";
  const labels: Record<string, string> = {
    phone: "Phone call",
    video: "Video call",
    their_place: forOwner ? "At the customer's place" : "At your place",
    business: "At the business",
    // "other" has no label: the owner's text says it all.
  };
  return [labels[service.location_type] ?? "", service.location_text.trim()].filter(Boolean).join(" · ");
}
