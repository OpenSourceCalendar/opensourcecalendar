// The business's brand color drives the theme. Everything else stays neutral.

const DEFAULT_BRAND = "#334155";

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** CSS variables for a brand color: the color, readable text on it, and a variant safe as text on white. */
export function brandVars(color: string | undefined): Record<string, string> {
  const brand = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_BRAND;
  const lum = luminance(brand);
  // Pick whichever of near-white / near-black reads better on the brand.
  const onBrand = contrast(lum, 0.96) >= contrast(lum, 0.012) ? "#fbfbfc" : "#14161a";
  // A light brand (yellow, mint) can't be used as text on a white page; darken it for that job.
  const ink = contrast(lum, 1) >= 4.5 ? brand : `color-mix(in oklab, ${brand} 45%, #111)`;
  return { "--brand": brand, "--on-brand": onBrand, "--brand-ink": ink };
}

export function applyBrand(color: string | undefined) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(brandVars(color))) root.style.setProperty(k, v);
  const meta = document.querySelector('meta[name="theme-color"]') ?? document.head.appendChild(Object.assign(document.createElement("meta"), { name: "theme-color" }));
  meta.setAttribute("content", color ?? DEFAULT_BRAND);
}
