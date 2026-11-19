import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { accountApi, ApiError, type AccountConfig, type LoginBrand } from "../api";
import { getToken, setLoginPage, setToken as saveSession } from "../admin/session";
import { PasswordInput } from "../components/PasswordInput";
import { Turnstile } from "../components/Turnstile";
import { applyBrand, type PageStyle } from "../theme";

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

/** A client's logo and name above its sign-in forms. */
function BrandHead({ brand }: { brand: LoginBrand }) {
  return (
    <div className="brand-head">
      {brand.logo_url && <img className="brand-head-logo" src={brand.logo_url} alt="" />}
      <p className="sub">{brand.name}</p>
    </div>
  );
}

/**
 * One Turnstile widget per page, shared by the password form and the emailed-link form (two widgets on one page would
 * be confusing and slow). Each submit uses the token up, so `reset()` asks for a new one.
 */
function useTurnstile(siteKey: string | null | undefined) {
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const widget = siteKey ? <Turnstile siteKey={siteKey} action="login" onToken={setToken} resetKey={resetKey} /> : null;
  return {
    on: !!siteKey,
    token,
    widget,
    reset: () => {
      setToken(null);
      setResetKey((n) => n + 1);
    },
  };
}
type Human = ReturnType<typeof useTurnstile>;

/** Email + password. `loginPath` is remembered so a later "session ended" screen sends people back here. */
function PasswordForm({ loginPath, human }: { loginPath: string; human: Human }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!EMAIL_RE.test(email.trim())) return setError("Enter a valid email address.");
    if (!password) return setError("Enter your password.");
    if (human.on && !human.token) return setError("Please wait a moment for the security check.");
    const ts = human.token;
    setBusy(true);
    setError("");
    try {
      const s = await accountApi.passwordLogin({ email: email.trim(), password, ...(ts && { turnstile_token: ts }) });
      saveSession(s.token, "hosted");
      setLoginPage(s.client_slug ? `/login/${s.client_slug}` : loginPath);
      window.location.replace("/admin");
    } catch (err) {
      const code = err instanceof ApiError ? err.error : "";
      setError(
        code === "wrong_password" ? "Email or password is wrong."
        : code === "too_many_tries" ? "Too many tries. Wait 15 minutes, or use “Email me a sign-in link” below."
        : code === "turnstile_failed" ? "The security check didn't pass. Please try again."
        : code === "too_large" ? "That's too long."
        : code === "invalid_input" ? "Please check what you typed."
        : "We couldn't sign you in. Check your connection and try again.",
      );
      human.reset(); // a Turnstile token works once
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label className="label" htmlFor="pw-email">Email</label>
        <input id="pw-email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label className="label" htmlFor="pw-password">Password</label>
        <PasswordInput id="pw-password" value={password} onChange={setPassword} autoComplete="current-password" invalid={!!error} />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

function SignInOptions({ cfg, invite, google = true, human }: { cfg: AccountConfig; invite?: string; google?: boolean; human: Human }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState("");
  const googleUrl = `${cfg.public_url}/api/account/google/start${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state === "busy") return;
    if (!EMAIL_RE.test(email.trim())) return setError("Enter a valid email address.");
    if (human.on && !human.token) return setError("Please wait a moment for the security check.");
    setState("busy");
    setError("");
    try {
      await accountApi.emailLink({ email: email.trim(), ...(invite && { invite }), ...(human.token && { turnstile_token: human.token }) });
      human.reset(); // spent: the password form needs a fresh one
      setState("sent");
    } catch (err) {
      setError(err instanceof ApiError && err.error === "turnstile_failed" ? "The security check didn't pass. Please try again." : "We couldn't send the link. Check your connection and try again.");
      human.reset(); // a Turnstile token works once
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
      {cfg.google && google && (
        <a className="btn btn-secondary" href={googleUrl}>
          Continue with Google
        </a>
      )}
      {cfg.google && google && cfg.email && <p className="muted center">or</p>}
      {cfg.email && (
        <form className="form" onSubmit={submit} noValidate>
          <div className="field">
            <label className="label" htmlFor="acct-email">Email</label>
            <input id="acct-email" className="input" type="email" autoComplete="email" value={email} aria-invalid={!!error} onChange={(e) => setEmail(e.target.value)} />
          </div>
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
  const human = useTurnstile(cfg && cfg !== "off" ? cfg.turnstile_site_key : null);
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
      <SignInOptions cfg={cfg} invite={invite} human={human} />
      {human.widget}
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
  client_account: "This account signs in with email and password.",
};

export function LoginPage() {
  const cfg = useAccountConfig();
  const human = useTurnstile(cfg && cfg !== "off" ? cfg.turnstile_site_key : null);
  const [error] = useState(() => LOGIN_ERRORS[new URLSearchParams(window.location.search).get("error") ?? ""] ?? "");
  if (cfg === "off") return <Off />;
  if (!cfg) return <Loading />;
  return (
    <Card>
      <h1 className="title">Log in</h1>
      {error && <p className="field-error" role="alert">{error}</p>}
      {cfg.passwords && (
        <>
          <PasswordForm loginPath="/login" human={human} />
          <p className="muted center">or</p>
        </>
      )}
      <SignInOptions cfg={cfg} human={human} />
      {/* One security check for both forms. */}
      {human.widget}
    </Card>
  );
}

/** The calendar's look for /login/<slug> pages; "none" = not a hosted calendar (show the ordinary page). */
function useLoginBrand(cfg: AccountConfig | "off" | null, slug: string | undefined) {
  const [brand, setBrand] = useState<LoginBrand | "none" | null>(slug ? null : "none");
  useEffect(() => {
    if (!slug || !cfg || cfg === "off") return;
    accountApi.loginPage(slug).then(
      (b) => {
        applyBrand(b.color, b.style as PageStyle); // the style changes the colours too (Midnight lightens the brand)
        document.title = b.name ? `Log in · ${b.name}` : "Log in";
        setBrand(b);
      },
      () => setBrand("none"),
    );
  }, [cfg, slug]);
  return brand;
}

export function ClientLoginPage({ slug }: { slug: string }) {
  const cfg = useAccountConfig();
  const brand = useLoginBrand(cfg, slug);
  const human = useTurnstile(cfg && cfg !== "off" ? cfg.turnstile_site_key : null);
  useEffect(() => {
    // A renamed calendar: show the new address.
    if (brand && brand !== "none" && brand.slug !== slug) window.history.replaceState(null, "", `/login/${brand.slug}`);
  }, [brand, slug]);
  if (cfg === "off") return <Off />;
  if (!cfg || brand === null) return <Loading />;
  if (brand === "none") return <LoginPage />;
  return (
    <Card>
      <BrandHead brand={brand} />
      <h1 className="title">Log in</h1>
      {cfg.passwords && <PasswordForm loginPath={`/login/${brand.slug}`} human={human} />}
      <p className="muted center">Forgot your password? Get a one-time link instead:</p>
      <SignInOptions cfg={cfg} google={false} human={human} />
      {human.widget}
    </Card>
  );
}

export function VerifyPage({ slug }: { slug?: string }) {
  const cfg = useAccountConfig();
  const brand = useLoginBrand(cfg, slug);
  const [token] = useState(() => /(?:^#|&)t=([^&]+)/.exec(window.location.hash)?.[1] ?? "");
  const [state, setState] = useState<"ready" | "busy" | "error" | "already">(token ? "ready" : "error");
  const [error, setError] = useState(token ? "" : "This sign-in link is incomplete. Ask for a new one.");

  async function go() {
    setState("busy");
    try {
      const s = await accountApi.verify(token);
      saveSession(s.token, "hosted");
      setLoginPage(slug ? `/login/${slug}` : "/login");
      window.location.replace("/admin");
    } catch (err) {
      const code = err instanceof ApiError ? err.error : "";
      // Reopening a used link while still logged in here isn't a problem: offer the calendar instead.
      if (code === "link_expired" && getToken()) return setState("already");
      setError(code === "invite_used" ? "That invite has already been used." : code === "link_expired" ? "This link has expired or was already used. Ask for a new one." : "We couldn't log you in. Check your connection and try again.");
      setState("error");
    }
  }

  if (cfg === "off") return <Off />;
  if (!cfg || brand === null) return <Loading />;
  const branded = brand !== "none";
  return (
    <Card>
      {branded && <BrandHead brand={brand} />}
      <h1 className="title">{branded ? `Log in to ${brand.name || "your calendar"}` : "Log in to Open Source Calendar"}</h1>
      {state === "already" ? (
        <>
          <p className="lede">You're already logged in. This link has been used, so you don't need it again.</p>
          <a className="btn btn-primary" href="/admin">Go to your calendar</a>
        </>
      ) : state === "error" ? (
        <>
          <p className="field-error" role="alert">{error}</p>
          <a className="btn btn-secondary" href={slug ? `/login/${slug}` : "/login"}>Back to log in</a>
        </>
      ) : (
        <button type="button" className="btn btn-primary" onClick={go} disabled={state === "busy"}>
          {state === "busy" ? "Logging in…" : "Log in"}
        </button>
      )}
    </Card>
  );
}

type InviteInfo = { valid: false } | ({ valid: true; email: string } & LoginBrand);

/** /invite#t=…: a White-label client sets its password. The token stays in the fragment (never sent as a URL). */
export function InvitePage() {
  const cfg = useAccountConfig();
  const [token] = useState(() => /(?:^#|&)t=([^&]+)/.exec(window.location.hash)?.[1] ?? "");
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!cfg || cfg === "off") return;
    if (!token) return setInfo({ valid: false });
    accountApi.inviteCheck(token).then(
      (r) => {
        if (r.valid) {
          applyBrand(r.color, r.style as PageStyle);
          document.title = r.name ? `Set your password · ${r.name}` : "Set your password";
        }
        setInfo(r);
      },
      () => setInfo({ valid: false }),
    );
  }, [cfg, token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if ([...password.normalize("NFC")].length < 15) return setError("Use at least 15 characters. A short sentence works well.");
    setBusy(true);
    setError("");
    try {
      const s = await accountApi.inviteAccept(token, password);
      saveSession(s.token, "hosted");
      setLoginPage(s.client_slug ? `/login/${s.client_slug}` : "/login");
      window.location.replace("/admin");
    } catch (err) {
      const code = err instanceof ApiError ? err.error : "";
      if (code === "invite_invalid") return setInfo({ valid: false });
      setError(
        code === "password_weak" ? "This password is too common or too easy to guess. Try a longer one, like a short sentence."
        : code === "password_too_long" ? "Use 256 characters or fewer."
        : code === "too_many_tries" ? "Too many tries. Wait 15 minutes and try again."
        : code === "too_large" ? "That's too long."
        : code === "invalid_input" ? "Please check what you typed."
        : "We couldn't save your password. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  if (cfg === "off") return <Off />;
  if (!cfg || !info) return <Loading />;
  if (!info.valid) {
    return (
      <Card>
        <h1 className="title">This link has expired</h1>
        <p className="lede">It was already used or is more than 7 days old. Ask your provider to send a new one.</p>
      </Card>
    );
  }
  return (
    <Card>
      <BrandHead brand={info} />
      <h1 className="title">Set your password</h1>
      <p className="lede">Your booking calendar is ready. Choose a password for {info.email}.</p>
      <form className="form" onSubmit={submit} noValidate>
        {/* Lets password managers save the right email with the new password. */}
        <input type="email" autoComplete="username" value={info.email} readOnly hidden />
        <div className="field">
          <label className="label" htmlFor="invite-password">New password</label>
          <PasswordInput id="invite-password" value={password} onChange={setPassword} autoComplete="new-password" invalid={!!error} />
          <p className="hint">At least 15 characters. A short sentence you'll remember works well.</p>
        </div>
        {error && <p className="field-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : "Set password and sign in"}</button>
      </form>
    </Card>
  );
}
