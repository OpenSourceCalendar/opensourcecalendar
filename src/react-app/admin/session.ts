// The owner's session token. It arrives in the URL fragment (#session=…) or from the
// password login, and lives in sessionStorage: per tab, which suits an iframe.

const TOKEN = "bc_admin_session";
const MODE = "bc_admin_mode";
const CALENDAR = "bc_admin_calendar";

// Fallback for browsers that block storage inside a third-party iframe: lasts until the tab reloads.
const memory: Record<string, string | null> = {};

function read(key: string): string | null {
  if (memory[key]) return memory[key];
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  memory[key] = value;
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage blocked: the in-memory copy is all there is */
  }
}

/** Move a token from the address bar into storage, then strip it from the URL. True if there was one. */
export function captureSessionFromUrl(): boolean {
  const match = /(?:^#|&)session=([^&]+)/.exec(window.location.hash);
  if (!match) return false;
  setToken(match[1]); // tokens are base64url and a dot: nothing to decode
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}

export const getToken = () => read(TOKEN);

/** `mode` is "password" for the standalone login; a link from a host app passes nothing. */
export function setToken(token: string, mode?: "password"): void {
  write(TOKEN, token);
  write(MODE, mode ?? null);
}

export function clearToken(): void {
  write(TOKEN, null);
  write(MODE, null);
  write(CALENDAR, null);
}

/** Only password sign-ins get a Sign out button; a host app has its own. */
export const signedInWithPassword = () => read(MODE) === "password";

/** The calendar this tab last showed, to notice when a new sign-in link switches to another one. */
export const lastCalendarId = () => read(CALENDAR);
export const setLastCalendarId = (id: string) => write(CALENDAR, id);
