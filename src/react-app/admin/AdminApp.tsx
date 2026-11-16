import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { applyBrand } from "../theme";
import { adminApi, setUnauthorizedHandler, type AdminCalendar, type Customer, type GoogleStatus } from "./api";
import { Availability } from "./Availability";
import { Branding } from "./Branding";
import { CustomerPage } from "./CustomerPage";
import { Customers } from "./Customers";
import { Dashboard } from "./Dashboard";
import { Dialog } from "./Dialog";
import { NewEntry, type EntryStart } from "./NewEntry";
import { Schedule } from "./Schedule";
import { Notifications } from "./Notifications";
import { Services } from "./Services";
import { captureSessionFromUrl, clearToken, getToken, lastCalendarId, setLastCalendarId } from "./session";
import { Setup } from "./Setup";
import { Share } from "./Share";
import { ComingSoon, NAV, Shell } from "./Shell";
import { SignedOut } from "./SignedOut";
import { Toast, type Notify, type ToastMessage } from "./Toast";
import "./admin.css";
import { Google } from "./Google";

type State =
  | { kind: "loading" }
  | { kind: "signed-out"; ended: boolean }
  | { kind: "setup" }
  | { kind: "error" }
  | { kind: "ready"; calendar: AdminCalendar };

/** What every page gets. */
export interface PageProps {
  calendar: AdminCalendar;
  notify: Notify;
  navigate: (path: string) => void;
  /** Tell the app this page has unsaved changes, so leaving asks first. */
  setDirty: (dirty: boolean) => void;
  /** Hand back the calendar after saving a change to it. */
  onCalendar: (calendar: AdminCalendar) => void;
}

const SIGN_OUT = Symbol("sign out");

const cleanPath = () => window.location.pathname.replace(/\/+$/, "") || "/admin";

export function AdminApp() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [path, setPath] = useState(cleanPath);
  const [entry, setEntry] = useState<{ start?: EntryStart; customer?: Customer } | null>(null);
  // Bumped whenever New Entry saves, so the screen behind refetches.
  const [saves, setSaves] = useState(0);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // Where the owner was heading when the leave guard stopped them: a path, or signing out.
  const [leaveTo, setLeaveTo] = useState<string | typeof SIGN_OUT | null>(null);
  const dirty = useRef(false);
  const shownPath = useRef(path);
  shownPath.current = path;
  // True when this load was started by a sign-in link, which may point at another calendar.
  const fromLink = useRef(false);
  const loads = useRef(0);
  const ready = useRef(false);
  ready.current = state.kind === "ready";

  const closeToast = useCallback(() => setToast(null), []);
  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  // Not cleared here: a page clears its own flag when it unmounts, so it can't be lost while the page stays open.
  const go = useCallback((to: string) => {
    if (to !== cleanPath()) window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);

  const navigate = useCallback(
    (to: string) => {
      if (to === shownPath.current) return; // already here (e.g. tapping the open page in the phone menu)
      if (dirty.current) setLeaveTo(to);
      else go(to);
    },
    [go],
  );

  const load = useCallback(async () => {
    if (!getToken()) return setState({ kind: "signed-out", ended: false });
    const turn = ++loads.current;
    // A fresh link while the calendar is open reloads quietly, so nothing being typed is lost unless the business changes.
    if (!ready.current) setState({ kind: "loading" });
    try {
      const calendar = await adminApi.calendar();
      if (turn !== loads.current) return; // a newer link has taken over
      const before = lastCalendarId();
      if (fromLink.current && before && before !== calendar.id) {
        // The link was for a different business. Say so, and start from its dashboard.
        setEntry(null);
        setLeaveTo(null);
        dirty.current = false;
        go("/admin");
        setToast({ text: `Switched to ${calendar.branding.business_name || "another calendar"}` });
      }
      fromLink.current = false;
      setLastCalendarId(calendar.id);
      setState({ kind: "ready", calendar });
    } catch (e) {
      if (turn !== loads.current) return;
      fromLink.current = false;
      if (!(e instanceof ApiError)) throw e;
      if (e.status === 404) setState({ kind: "setup" });
      else if (e.status !== 401) setState({ kind: "error" }); // 401 is handled below
    }
  }, [go]);

  useEffect(() => {
    // `||` so a second run of this effect (React's dev double-run) doesn't forget the link.
    fromLink.current = captureSessionFromUrl() || fromLink.current;
    setUnauthorizedHandler(() => setState({ kind: "signed-out", ended: true }));
    void load();
    const onPop = () => {
      const to = cleanPath();
      if (dirty.current && to !== shownPath.current) {
        // Undo the browser's move until the owner decides.
        window.history.pushState(null, "", shownPath.current);
        setLeaveTo(to);
      } else setPath(to);
    };
    // A host app can hand an already-open calendar a new link; only the fragment changes, so the page doesn't reload.
    const onHash = () => {
      if (!captureSessionFromUrl()) return;
      fromLink.current = true;
      void load();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [load]);

  const calendar = state.kind === "ready" ? state.calendar : null;

  // Google Calendar status for the menu and the Google page: loaded with each calendar, and again when the
  // owner comes back to this tab (at most once a minute) or leaves the Google page.
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const googleChecked = useRef(0);
  const calendarId = calendar?.id;
  const googleFor = useRef<string | undefined>(undefined);
  googleFor.current = calendarId;
  const loadGoogle = useCallback(() => {
    googleChecked.current = Date.now();
    const asked = googleFor.current;
    // A late answer for the calendar we just switched away from is dropped.
    adminApi.google().then((g) => asked === googleFor.current && setGoogle(g), () => {});
  }, []);
  useEffect(() => {
    setGoogle(null);
    if (!calendarId) return;
    loadGoogle();
    const onFocus = () => Date.now() - googleChecked.current > 60_000 && loadGoogle();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [calendarId, loadGoogle]);
  const onGooglePage = path === "/admin/google";
  const wasOnGooglePage = useRef(false);
  useEffect(() => {
    if (wasOnGooglePage.current && !onGooglePage && calendarId) loadGoogle();
    wasOnGooglePage.current = onGooglePage;
  }, [onGooglePage, calendarId, loadGoogle]);

  useEffect(() => {
    applyBrand(calendar?.branding.color);
    document.title = calendar?.branding.business_name ? `Calendar · ${calendar.branding.business_name}` : "Calendar";
  }, [calendar]);

  function signOut() {
    if (dirty.current) return setLeaveTo(SIGN_OUT);
    leave();
  }

  function leave() {
    clearToken();
    setLeaveTo(null);
    dirty.current = false;
    setEntry(null);
    setState({ kind: "signed-out", ended: false });
  }

  const toastEl = <Toast toast={toast} onClose={closeToast} />;

  if (state.kind === "loading") {
    return (
      <div className="admin-center">
        <span className="skeleton block admin-card" aria-label="Loading" />
        {toastEl}
      </div>
    );
  }
  if (state.kind === "signed-out") return <SignedOut ended={state.ended} onSignedIn={load} />;
  if (state.kind === "setup") {
    return (
      <Setup
        onCreated={(created) => {
          setLastCalendarId(created.id);
          setState({ kind: "ready", calendar: created });
        }}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <div className="admin-center">
        <main className="admin-card stack">
          <h1 className="title">We couldn't load your calendar</h1>
          <p className="lede">Check your connection and try again.</p>
          <button type="button" className="btn btn-primary" onClick={load}>
            Try again
          </button>
        </main>
      </div>
    );
  }

  const page: PageProps = {
    calendar: state.calendar,
    notify: setToast,
    navigate,
    setDirty,
    onCalendar: (next) => setState({ kind: "ready", calendar: next }),
  };
  const customerId = path.startsWith("/admin/customers/") ? decodeURIComponent(path.slice("/admin/customers/".length)) : null;
  const known = NAV.find((n) => n.path === path);

  return (
    <Shell calendar={state.calendar} google={google} path={path} navigate={navigate} onNewEntry={() => setEntry({})} onSignOut={signOut}>
      {path === "/admin" ? (
        <Dashboard calendar={state.calendar} reloadKey={saves} navigate={navigate} onNewEntry={() => setEntry({})} />
      ) : path === "/admin/schedule" ? (
        <Schedule calendar={state.calendar} reloadKey={saves} notify={setToast} onNewEntry={(start) => setEntry({ start })} />
      ) : path === "/admin/services" ? (
        <Services {...page} />
      ) : path === "/admin/availability" ? (
        <Availability {...page} />
      ) : path === "/admin/customers" ? (
        <Customers {...page} />
      ) : customerId ? (
        <CustomerPage key={customerId} {...page} id={customerId} reloadKey={saves} onBook={(customer) => setEntry({ customer })} />
      ) : path === "/admin/notifications" ? (
        <Notifications {...page} />
      ) : path === "/admin/branding" ? (
        <Branding {...page} />
      ) : path === "/admin/share" ? (
        <Share {...page} />
      ) : path === "/admin/google" ? (
        <Google {...page} google={google} onGoogle={setGoogle} />
      ) : known ? (
        <ComingSoon title={known.label} />
      ) : (
        <>
          <h1 className="admin-title">Page not found</h1>
          <p className="muted">
            <a href="/admin" onClick={(e) => (e.preventDefault(), navigate("/admin"))}>
              Go to the dashboard
            </a>
          </p>
        </>
      )}
      {entry && (
        <NewEntry
          calendar={state.calendar}
          start={entry.start}
          customer={entry.customer}
          onClose={() => setEntry(null)}
          onCreated={() => setSaves((n) => n + 1)}
        />
      )}
      {leaveTo && (
        <Dialog kind="modal" title="Leave without saving?" onClose={() => setLeaveTo(null)}>
          <p className="lede">Your changes on this page haven't been saved.</p>
          <div className="two">
            <button type="button" className="btn btn-secondary" onClick={() => setLeaveTo(null)}>
              Stay
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                const to = leaveTo;
                setLeaveTo(null);
                dirty.current = false;
                if (to === SIGN_OUT) leave();
                else go(to);
              }}
            >
              Leave
            </button>
          </div>
        </Dialog>
      )}
      {toastEl}
    </Shell>
  );
}
