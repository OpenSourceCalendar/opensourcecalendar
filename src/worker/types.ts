export type Bindings = Env & { SETUP_TOKEN?: string; MANAGE_SECRET?: string; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string; SESSION_SECRET?: string; OWNER_PASSWORD?: string;
  /** Address emails are sent from, on a domain onboarded to Cloudflare Email Sending. Unset = no email. */
  EMAIL_FROM?: string;
  /** Base for links in emails, e.g. https://book.example.com. Unset = the address the booking came from. */
  PUBLIC_URL?: string;
  /** "on" shows the Open Source Calendar website (home, privacy, terms, waitlist). Off by default, so a self-hosted copy gets a plain front page. */
  MARKETING_SITE?: string;
  /** "invite" turns on hosted sign-up and log-in (invite-only) when PUBLIC_URL is also set. Unset = off (self-hosted copies). */
  SIGNUP?: string;
  /** 32 random bytes, base64. Mixed into every password hash; kept apart from D1 so a copy of the database can't be
   * cracked on its own. Unset = password sign-in off. Changing it makes every stored password stop working. */
  PASSWORD_PEPPER?: string;
  /** Google OAuth client (Google Cloud → OAuth client ID, type "Web application"). Unset = Google sync off. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** 32 random bytes, base64. Encrypts stored Google tokens. Changing it disconnects every calendar. */
  GOOGLE_TOKEN_KEY?: string;
  /** Stripe billing for hosted accounts. All six (key, webhook secret, four prices) + hosted sign-up = billing on. */
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO_MONTH?: string;
  STRIPE_PRICE_PRO_YEAR?: string;
  STRIPE_PRICE_WL_MONTH?: string;
  STRIPE_PRICE_WL_YEAR?: string;
  /** Where operator notices (disputes, duplicate subscriptions) go. */
  OPERATOR_EMAIL?: string;
};

export type AppRow = { id: string; name: string };

export type CalendarRow = {
  id: string;
  app_id: string;
  external_user_id: string;
  /** The hosted account that owns this calendar; null for host apps and standalone installs. */
  account_user_id: string | null;
  slug: string;
  time_zone: string;
  rules: string;
  branding: string;
  notifications: string;
  created_at: number;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    app: AppRow;
    userId: string;
    calendar: CalendarRow;
    /** A White-label client's own sign-in: the one calendar it may open. Null for everyone else. */
    clientCalendarId: string | null;
    /** When this session's token was issued (0 = unknown), for "signed in recently" checks. */
    sessionIssuedAt: number;
    /** The hosted account's session_version this token carries (0 otherwise); version bumps are conditional on it. */
    sessionVersion: number;
  };
};
