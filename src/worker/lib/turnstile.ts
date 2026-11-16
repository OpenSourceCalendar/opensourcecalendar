const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * True only for a token Cloudflare accepts that was made by this booking page: the expected action, on one of
 * the expected hostnames (a token from another site using the same site key doesn't count). Fails closed.
 */
export async function verifyTurnstile(
  secret: string, token: string, ip: string | null,
  expected: { action: string; hostnames: string[] },
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!token || token.length > 2048 || !expected.hostnames.length) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set("remoteip", ip);
  try {
    const res = await fetcher(SITEVERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean; action?: string; hostname?: string };
    return data.success === true && data.action === expected.action && expected.hostnames.includes(data.hostname ?? "");
  } catch {
    return false;
  }
}
