export type Interval = { start: number; end: number };

/** Remove every `cuts` range from `base`. Ranges are half-open: [start, end). */
export function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let out = base;
  for (const cut of cuts) {
    out = out.flatMap((iv) => {
      if (cut.end <= iv.start || cut.start >= iv.end) return [iv];
      const parts: Interval[] = [];
      if (cut.start > iv.start) parts.push({ start: iv.start, end: cut.start });
      if (cut.end < iv.end) parts.push({ start: cut.end, end: iv.end });
      return parts;
    });
  }
  return out;
}
