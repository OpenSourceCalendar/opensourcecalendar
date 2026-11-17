// The business's brand color drives the theme. Everything else stays neutral.

const DEFAULT_BRAND = "#334155";
/** Midnight's card color; its brand must read on this. */
const MIDNIGHT_SURFACE = "#161a20";
const MIDNIGHT_PAGE = "#0d0f13";

export const PAGE_STYLES = ["classic", "clean", "soft", "bold", "midnight"] as const;
export type PageStyle = (typeof PAGE_STYLES)[number];

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** WCAG contrast ratio between two #rrggbb colors. */
export const contrastOf = (a: string, b: string) => contrast(luminance(a), luminance(b));

/** `hex` mixed toward white by `t` (0..1), as #rrggbb. */
function towardWhite(hex: string, t: number): string {
  return "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + 255 * t).toString(16).padStart(2, "0")).join("");
}

/** CSS variables for a brand color and page style: the color, readable text on it, and a variant safe as text on the page. */
export function brandVars(color: string | undefined, style: PageStyle = "classic"): Record<string, string> {
  const raw = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : DEFAULT_BRAND;
  if (style === "midnight") {
    // On a dark page the brand is lightened until it reads, and is used for text and fills alike.
    let t = 0.38;
    let brand = towardWhite(raw, t);
    while (contrastOf(brand, MIDNIGHT_SURFACE) < 4.5 && t < 1) brand = towardWhite(raw, (t = Math.min(1, t + 0.05)));
    const onBrand = contrastOf(MIDNIGHT_PAGE, brand) >= contrastOf("#fbfbfc", brand) ? MIDNIGHT_PAGE : "#fbfbfc";
    return { "--brand": brand, "--on-brand": onBrand, "--brand-ink": brand };
  }
  const lum = luminance(raw);
  // Pick whichever of near-white / near-black reads better on the brand.
  const onBrand = contrast(lum, 0.96) >= contrast(lum, 0.012) ? "#fbfbfc" : "#14161a";
  // A light brand (yellow, mint) can't be used as text on a white page; darken it for that job.
  const ink = contrast(lum, 1) >= 4.5 ? raw : `color-mix(in oklab, ${raw} 45%, #111)`;
  return { "--brand": raw, "--on-brand": onBrand, "--brand-ink": ink };
}

export function applyBrand(color: string | undefined, style: PageStyle = "classic") {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(brandVars(color, style))) root.style.setProperty(k, v);
  const meta = document.querySelector('meta[name="theme-color"]') ?? document.head.appendChild(Object.assign(document.createElement("meta"), { name: "theme-color" }));
  meta.setAttribute("content", style === "midnight" ? MIDNIGHT_PAGE : color ?? DEFAULT_BRAND);
}
