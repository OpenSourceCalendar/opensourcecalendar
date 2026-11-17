export type Bindings = Env & { SETUP_TOKEN?: string; MANAGE_SECRET?: string; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string; SESSION_SECRET?: string; OWNER_PASSWORD?: string;
  /** Address emails are sent from, on a domain onboarded to Cloudflare Email Sending. Unset = no email. */
  EMAIL_FROM?: string;
  /** Base for links in emails, e.g. https://book.example.com. Unset = the address the booking came from. */
  PUBLIC_URL?: string;
  /** "on" shows the Open Source Calendar website (home, privacy, terms, waitlist). Off by default, so a self-hosted copy gets a plain front page. */
  MARKETING_SITE?: string;
  /** "invite" turns on hosted sign-up and log-in (invite-only) when PUBLIC_URL is also set. Unset = off (self-hosted copies). */
  SIGNUP?: string;
  /** Google OAuth client (Google Cloud → OAuth client ID, type "Web application"). Unset = Google sync off. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** 32 random bytes, base64. Encrypts stored Google tokens. Changing it disconnects every calendar. */
  GOOGLE_TOKEN_KEY?: string;
};

export type AppRow = { id: string; name: string };

export type CalendarRow = {
  id: string;
  app_id: string;
  external_user_id: string;
  slug: string;
  time_zone: string;
  rules: string;
  branding: string;
  notifications: string;
  created_at: number;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: { app: AppRow; userId: string; calendar: CalendarRow };
};
