import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { accountApi, ApiError, type AccountConfig } from "../api";
import { setToken as saveSession } from "../admin/session";
import { Turnstile } from "../components/Turnstile";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WAITLIST = "https://opensourcecalendar.com/#waitlist";

/** The install's sign-in options; moves the browser to PUBLIC_URL's origin first, keeping path, query and fragment. */
function useAccountConfig(): AccountConfig | "off" | null {
  const [cfg, setCfg] = useState<AccountConfig | "off" | null>(null);
  useEffect(() => {
    accountApi.config().then(
      (c) => {
        const home = new URL(c.public_url).origin;
        if (window.location.origin !== home) {
          window.location.replace(home + window.location.pathname + window.location.search + window.location.hash);
          return;
        }
        setCfg(c);
      },
      () => setCfg("off"),
    );
  }, []);
  return cfg;
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="admin-center">
      <main className="admin-card">{children}</main>
    </div>
  );
}
const Loading = () => <Card><span className="skeleton block" aria-label="Loading" /></Card>;
const Off = () => (
  <Card>
    <h1 className="title">Accounts aren't available here</h1>
    <p className="lede">To book an appointment, use the link the business gave you.</p>
  </Card>
);

function SignInOptions({ cfg, invite }: { cfg: AccountConfig; invite?: string }) {
  const [email, setEmail] = useState("");
  const [ts, setTs] = useState<string | null>(null);
  const [tsReset, setTsReset] = useState(0);
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState("");
  const google = `${cfg.public_url}/api/account/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state === "busy") return;
    if (!EMAIL_RE.test(email.trim())) return setError("Enter a valid email address.");
    if (cfg.turnstile_site_key && !ts) return setError("Please wait a moment for the security check.");
    setState("busy");
    setError("");
    try {
      await accountApi.emailLink({ email: email.trim(), ...(invite && { invite }), ...(ts && { turnstile_token: ts }) });
      setState("sent");
    } catch (err) {
      setError(err instanceof ApiError && err.error === "turnstile_failed" ? "The security check didn't pass. Please try again." : "We couldn't send the link. Check your connection and try again.");
      setTsReset((n) => n + 1);
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <p className="lede" role="status">
        Check your email. If you have an account{invite ? " or a valid invite" : ""}, a sign-in link is on its way. It works for 15 minutes.
      </p>
    );
  }
  return (
    <div className="stack">
      {cfg.google && (
        <a className="btn btn-secondary" href={google}>
          Continue with Google
        </a>
      )}
      {cfg.google && cfg.email && <p className="muted center">or</p>}
      {cfg.email && (
        <form className="form" onSubmit={submit} noValidate>
          <div className="field">
            <label className="label" htmlFor="acct-email">Email</label>
            <input id="acct-email" className="input" type="email" autoComplete="email" value={email} aria-invalid={!!error} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {cfg.turnstile_site_key && <Turnstile siteKey={cfg.turnstile_site_key} action="login" onToken={setTs} resetKey={tsReset} />}
          {error && <p className="field-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={state === "busy"}>
            {state === "busy" ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      )}
    </div>
  );
}

export function SignupPage() {
  const cfg = useAccountConfig();
  const [invite] = useState(() => new URLSearchParams(window.location.search).get("invite") ?? "");
  const [valid, setValid] = useState<boolean | null>(null);
  useEffect(() => {
    if (!cfg || cfg === "off") return; // on another host the config hook moves us, query included
    // The invite works once; keep it out of the address bar (and so out of Referer headers and history).
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    if (!invite) return setValid(false);
    accountApi.invite(invite).then((r) => setValid(r.valid), () => setValid(false));
  }, [cfg, invite]);

  if (cfg === "off") return <Off />;
  if (!cfg || valid === null) return <Loading />;
  if (!valid) {
    return (
      <Card>
        <h1 className="title">Sign-ups open soon</h1>
        <p className="lede">This invite has been used or has expired. Join the waitlist and we'll email you when sign-ups open.</p>
        <a className="btn btn-primary" href={WAITLIST}>Join the waitlist</a>
        <p className="muted">Already have an account? <a href="/login">Log in</a></p>
      </Card>
    );
  }
  return (
    <Card>
      <h1 className="title">Create your account</h1>
      <p className="lede">You've been invited to Open Source Calendar. Choose how you'd like to sign in.</p>
      <SignInOptions cfg={cfg} invite={invite} />
    </Card>
  );
}

const LOGIN_ERRORS: Record<string, string> = {
  no_account: "We couldn't find an account for that Google login. Sign-ups are invite-only for now.",
  google_mismatch: "That email is linked to a different Google account. Use that one, or the email link.",
  invite_used: "That invite has already been used.",
  expired: "That sign-in took too long. Please try again.",
  cancelled: "Google sign-in was cancelled.",
  google: "Google sign-in didn't work. Please try again or use the email link.",
};

export function LoginPage() {
  const cfg = useAccountConfig();
  const [error] = useState(() => LOGIN_ERRORS[new URLSearchParams(window.location.search).get("error") ?? ""] ?? "");
  if (cfg === "off") return <Off />;
  if (!cfg) return <Loading />;
  return (
    <Card>
      <h1 className="title">Log in</h1>
      {error && <p className="field-error" role="alert">{error}</p>}
      <SignInOptions cfg={cfg} />
    </Card>
  );
}

export function VerifyPage() {
  const cfg = useAccountConfig();
  const [token] = useState(() => /(?:^#|&)t=([^&]+)/.exec(window.location.hash)?.[1] ?? "");
  const [state, setState] = useState<"ready" | "busy" | "error">(token ? "ready" : "error");
  const [error, setError] = useState(token ? "" : "This sign-in link is incomplete. Ask for a new one.");

  async function go() {
    setState("busy");
    try {
      const s = await accountApi.verify(token);
      saveSession(s.token, "hosted");
      window.location.replace("/admin");
    } catch (err) {
      const code = err instanceof ApiError ? err.error : "";
      setError(code === "invite_used" ? "That invite has already been used." : code === "link_expired" ? "This link has expired or was already used. Ask for a new one." : "We couldn't log you in. Check your connection and try again.");
      setState("error");
    }
  }

  if (cfg === "off") return <Off />;
  if (!cfg) return <Loading />;
  return (
    <Card>
      <h1 className="title">Log in to Open Source Calendar</h1>
      {state === "error" ? (
        <>
          <p className="field-error" role="alert">{error}</p>
          <a className="btn btn-secondary" href="/login">Back to log in</a>
        </>
      ) : (
        <button type="button" className="btn btn-primary" onClick={go} disabled={state === "busy"}>
          {state === "busy" ? "Logging in…" : "Log in"}
        </button>
      )}
    </Card>
  );
}
