// The "is this password too easy?" check, run only when a password is set or changed (never at sign-in).
// HaveIBeenPwned's range API gets the first 5 characters of the password's SHA-1 and nothing else; the rest is compared
// here. If it can't be reached the password is allowed: a breach list outage must not lock people out.
const RANGE = "https://api.pwnedpasswords.com/range/";
const PRODUCT = "opensourcecalendar";

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** "guessable" if it contains one of `words` (email, its first part, business name) or the product name. */
export async function weakPassword(password: string, words: (string | null | undefined)[], fetcher: typeof fetch = fetch): Promise<"breached" | "guessable" | null> {
  const pw = password.normalize("NFC").toLowerCase();
  const squashed = pw.replace(/\s+/g, "");
  const parts = [PRODUCT];
  for (const w of words) {
    const x = w?.trim().toLowerCase();
    if (!x) continue;
    if (x.includes("@")) parts.push(x, x.split("@")[0]);
    else parts.push(x, x.replace(/\s+/g, ""));
  }
  if (parts.some((p) => p.length >= 4 && (pw.includes(p) || squashed.includes(p)))) return "guessable";

  const hash = await sha1Hex(password.normalize("NFC"));
  try {
    const res = await fetcher(`${RANGE}${hash.slice(0, 5)}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const suffix = hash.slice(5);
    for (const line of (await res.text()).split("\n")) {
      const [s, count] = line.trim().split(":");
      if (s === suffix && Number(count) > 0) return "breached";
    }
    return null;
  } catch (err) {
    console.error(JSON.stringify({ event: "hibp_skipped", error: String(err).slice(0, 100) }));
    return null;
  }
}
