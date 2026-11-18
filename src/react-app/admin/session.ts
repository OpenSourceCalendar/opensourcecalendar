// The owner's session token. It arrives in the URL fragment (#session=… from a host app, #login=… from a
// hosted account's Google sign-in), from the password login, or from an emailed sign-in link.
// Host-app and password sessions live in sessionStorage: per tab, which suits an iframe. Hosted accounts
// live in localStorage: shared by tabs and kept for the token's 30 days.

const TOKEN = "bc_admin_session";
const MODE = "bc_admin_mode";
const CALENDAR = "bc_admin_calendar";
/** Survives sign-out and expiry, so the signed-out screen knows to offer Log in. */
const LAST_LOGIN = "bc_last_login";
const CLIENT = "bc_admin_client";

// Fallback for browsers that block storage inside a third-party iframe: lasts until the tab reloads.
const memory: Record<string, string | null> = {};

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    memory[key] = value; // storage blocked: the session lasts for this page only
  }
}

// The business this tab works on, read from localStorage once at startup. Requests read only this variable, so another
// tab picking a different business can't silently send this tab's saves to it. A new tab starts from the last choice.
let activeClient: string | null = readLocal(CLIENT);

function read(key: string): string | null {
  if (memory[key]) return memory[key];
  let value: string | null = null;
  try {
    value = sessionStorage.getItem(key);
  } catch {
    value = null;
  }
  return value ?? (key === TOKEN || key === MODE ? readLocal(key) : null);
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
  const login = /(?:^#|&)login=([^&]+)/.exec(window.location.hash);
  const link = login ? null : /(?:^#|&)session=([^&]+)/.exec(window.location.hash);
  if (!login && !link) return false;
  // Tokens are base64url and a dot: nothing to decode.
  if (login) setToken(login[1], "hosted");
  else setToken(link![1]);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return true;
}

export const getToken = () => read(TOKEN);

/** "password" for the standalone login, "hosted" for accounts (30 days, all tabs); a host-app link passes nothing. */
export function setToken(token: string, mode?: "password" | "hosted"): void {
  if (mode === "hosted") {
    // An older per-tab session would hide this one (reads check sessionStorage first).
    write(TOKEN, null);
    write(MODE, null);
    write(CALENDAR, null);
    writeLocal(TOKEN, token);
    writeLocal(MODE, "hosted");
    writeLocal(LAST_LOGIN, "hosted");
    return;
  }
  write(TOKEN, token);
  write(MODE, mode ?? null);
}

export function clearToken(): void {
  write(TOKEN, null);
  write(MODE, null);
  write(CALENDAR, null);
  writeLocal(TOKEN, null);
  writeLocal(MODE, null);
  // A different account may sign in next.
  activeClient = null;
  writeLocal(CLIENT, null);
}

/** Password and hosted sign-ins get a Sign out button; a host app has its own. */
export const canSignOut = () => read(MODE) === "password" || read(MODE) === "hosted";

/** True when the last sign-in in this browser was a hosted account, even after it ended. */
export const lastLoginWasHosted = () => readLocal(LAST_LOGIN) === "hosted";

/** The calendar this tab last showed, to notice when a new sign-in link switches to another one. */
export const lastCalendarId = () => read(CALENDAR);
export const setLastCalendarId = (id: string) => write(CALENDAR, id);

/** The client business this tab is working on; null = the agency's own calendar. */
export const getClientId = () => activeClient;
/** Changes this tab's business and remembers it for the next tab or reload. */
export function setClientId(id: string | null): void {
  activeClient = id;
  writeLocal(CLIENT, id);
}
