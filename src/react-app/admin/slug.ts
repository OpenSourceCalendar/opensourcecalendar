import { useEffect, useState } from "react";
import { slugInUse } from "./api";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export type SlugState = "empty" | "invalid" | "checking" | "available" | "taken" | "unchanged";

export const SLUG_HINT: Record<SlugState, string> = {
  empty: "Lowercase letters, numbers and dashes.",
  invalid: "Use 3 to 40 lowercase letters, numbers and dashes. Start and end with a letter or number.",
  checking: "Checking…",
  available: "Available",
  taken: "Taken. Try another.",
  unchanged: "This is your link now.",
};

/** Keep only what a booking link may contain, as the owner types. */
export const cleanSlug = (typed: string) => typed.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/**
 * Live check of a booking link name. `current` is the calendar's own name, which is
 * "unchanged" rather than "taken". The server still decides on save.
 */
export function useSlugCheck(slug: string, current?: string): SlugState {
  const [state, setState] = useState<SlugState>("empty");
  useEffect(() => {
    if (!slug) return setState("empty");
    if (slug === current) return setState("unchanged");
    if (!SLUG_RE.test(slug)) return setState("invalid");
    setState("checking");
    let live = true;
    const timer = setTimeout(() => {
      slugInUse(slug).then(
        (used) => live && setState(used ? "taken" : "available"),
        () => live && setState("available"), // offline: the server decides on save
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [slug, current]);
  return state;
}
