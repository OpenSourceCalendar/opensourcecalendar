import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { applyBrand } from "../theme";
import {
  adminApi,
  canAddClients,
  onWhiteLabel,
  setUnauthorizedHandler,
  type AccountInfo,
  type AdminCalendar,
  type BillingInfo,
  type ClientList,
  type Customer,
  type GoogleStatus,
} from "./api";
import { Account } from "./Account";
import { AddClient } from "./AddClient";
import { Availability } from "./Availability";
import { Branding } from "./Branding";
import { Clients } from "./Clients";
import { CustomerPage } from "./CustomerPage";
import { Customers } from "./Customers";
import { Dashboard } from "./Dashboard";
import { Dialog } from "./Dialog";
import { NewEntry, type EntryStart } from "./NewEntry";
import { Schedule } from "./Schedule";
import { Notifications } from "./Notifications";
import { Plan } from "./Plan";
import { Services } from "./Services";
import { captureSessionFromUrl, clearToken, getClientId, getToken, isHostedSession, lastCalendarId, setClientId, setLastCalendarId } from "./session";
import { DEFAULT_WEEK, FIRST_SERVICE, Setup } from "./Setup";
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
  /** A client's own sign-in whose calendar was deleted by the agency. */
  | { kind: "gone" }
  /** `account` is null for a host-app or standalone session (or a failure there): treated as the agency. */
  | { kind: "ready"; calendar: AdminCalendar; account: AccountInfo | null };

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
const ADD_CLIENT = Symbol("add client");

/** The chosen business's calendar. A stored client that's gone or isn't this account's falls back to the agency's own. */
async function loadCalendar(): Promise<AdminCalendar> {
  try {
    return await adminApi.calendar();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404 || !getClientId()) throw e;
    setClientId(null);
    return adminApi.calendar();
  }
}

const cleanPath = () => window.location.pathname.replace(/\/+$/, "") || "/admin";

export function AdminApp() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [path, setPath] = useState(cleanPath);
  const [entry, setEntry] = useState<{ start?: EntryStart; customer?: Customer } | null>(null);
  // Bumped whenever New Entry saves, so the screen behind refetches.
  const [saves, setSaves] = useState(0);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // Where the owner was heading when the leave guard stopped them: a path, another business (and its page), adding one, or signing out.
  const [leaveTo, setLeaveTo] = useState<string | typeof SIGN_OUT | typeof ADD_CLIENT | { client: string; to?: string } | null>(null);
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
    // A hosted session must know its role: a failed /account is an error, never the agency's screens.
    const hosted = isHostedSession();
    let accountFailed = false;
    try {
      // The role comes with the calendar, so a client's screens never ask for billing or the client list.
      const [calendar, account] = await Promise.all([
        loadCalendar(),
        adminApi.account().catch((e: unknown) => {
          if (!hosted) return null;
          accountFailed = true;
          throw e;
        }),
      ]);
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
      setState({ kind: "ready", calendar, account });
    } catch (e) {
      if (turn !== loads.current) return;
      fromLink.current = false;
      if (accountFailed && !(e instanceof ApiError && e.status === 401)) return setState({ kind: "error" }); // 401 is handled below
      if (!(e instanceof ApiError)) throw e;
      if (e.status === 404) {
        // No calendar: an agency sets one up; a client whose calendar was removed can't, so it's told so instead.
        let gone = false;
        try {
          gone = (await adminApi.account()).role === "client";
        } catch {
          // Unknown: Setup, as before.
        }
        if (turn === loads.current) setState(gone ? { kind: "gone" } : { kind: "setup" });
      } else if (e.status !== 401) setState({ kind: "error" }); // 401 is handled below
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
  const role = state.kind === "ready" ? (state.account?.role ?? null) : null;
  // Signed in as a White-label client: its own calendar only, no plans, no client list.
  const clientUser = role === "client";

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
  // The account's plan, for the Plan page, the banners and the Free notes. Loaded with each calendar; a failure
  // counts as billing off, so the screens look as they do without billing.
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const loadBilling = useCallback(() => {
    const asked = googleFor.current;
    const take = (b: BillingInfo) => asked === googleFor.current && setBilling(b);
    adminApi.billing().then(take, () => take({ enabled: false }));
  }, []);
  useEffect(() => {
    setBilling(null);
    // A client's plan is the agency's business: its screens look as they do without billing.
    if (calendarId) clientUser ? setBilling({ enabled: false }) : loadBilling();
  }, [calendarId, clientUser, loadBilling]);

  // The account's businesses, for the White-label Clients page (hosted accounts only; others get a 404 and no list).
  // Reloaded when another business opens, this one's name changes, or the Clients page changes a sign-in.
  // Undefined until the first answer; null without a list.
  const [clients, setClients] = useState<ClientList | null | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [clientsKey, setClientsKey] = useState(0);
  const reloadClients = () => setClientsKey((n) => n + 1);
  const businessName = calendar?.branding.business_name;
  useEffect(() => {
    if (clientUser) return setClients(null);
    if (!calendarId) return;
    // Only a 404 means "no list" (not a hosted account); after any other failure it stays unknown until the next load.
    adminApi.clients().then(setClients, (e) => e instanceof ApiError && e.status === 404 && setClients(null));
  }, [calendarId, businessName, clientsKey, clientUser]);

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

  /**
   * Open another business: its own screens, from its dashboard (or `to`). The agency's own is stored as "no client".
   * The old screens go first: from here on every call is about the new business. `prepare` runs before it loads.
   */
  async function switchClient(id: string, to = "/admin", prepare?: () => Promise<unknown>) {
    setClientId(clients?.calendars.find((x) => x.id === id)?.home ? null : id);
    setEntry(null);
    setLeaveTo(null);
    dirty.current = false;
    setState({ kind: "loading" });
    go(to);
    switched.current = true;
    if (prepare) await prepare();
    void load();
  }

  // After a switch the screens are new (Shell remounts), so move focus to them instead of leaving it on the old screens.
  const switched = useRef(false);
  useEffect(() => {
    if (!switched.current || !calendarId) return;
    switched.current = false;
    document.querySelector<HTMLElement>(".admin-main")?.focus();
  }, [calendarId]);

  /** Add client opens another business when done, so unsaved edits on this page are confirmed first. */
  function addClient() {
    if (dirty.current) setLeaveTo(ADD_CLIENT);
    else setAdding(true);
  }

  const homeId = clients?.calendars.find((x) => x.home)?.id;
  /** Open a client from the Clients page: its dashboard, with the Viewing bar. */
  function openClient(id: string) {
    if (dirty.current) setLeaveTo({ client: id });
    else void switchClient(id);
  }
  /** Back to the agency's own calendar, on the Clients page. */
  function backToClients() {
    if (!homeId) return;
    if (dirty.current) setLeaveTo({ client: homeId, to: "/admin/clients" });
    else void switchClient(homeId, "/admin/clients");
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
          setState({ kind: "ready", calendar: created, account: null });
          // The role isn't known yet on a first setup; read it so the Account link shows.
          adminApi.account().then(
            (account) => setState((s) => (s.kind === "ready" && s.calendar.id === created.id ? { ...s, account } : s)),
            () => {},
          );
        }}
      />
    );
  }
  if (state.kind === "gone") {
    return (
      <div className="admin-center">
        <main className="admin-card stack">
          <h1 className="title">This calendar is no longer available</h1>
          <p className="lede">Please contact your provider if you think this is a mistake.</p>
          <button type="button" className="btn btn-primary" onClick={leave}>
            Sign out
          </button>
        </main>
      </div>
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
    // A saved calendar may come back without `access`; keep the one we had.
    onCalendar: (next) => setState({ kind: "ready", calendar: { ...next, access: next.access ?? state.calendar.access }, account: state.account }),
  };
  const customerId = path.startsWith("/admin/customers/") ? decodeURIComponent(path.slice("/admin/customers/".length)) : null;
  const known = NAV.find((n) => n.path === path);
  const shown = clients?.calendars.find((x) => x.id === state.calendar.id);
  // Without a list (not a hosted account) it's the account's own calendar. With one that doesn't have this calendar yet
  // (still loading, or just added), whether it's a client or paused isn't known, so the plan notes wait.
  const clientKnown = clients === null || !!shown;
  // A client's own sign-in has no list: the server says whether its calendar is paused.
  const paused = clientUser ? !!state.calendar.access?.paused : !!shown?.paused;
  const client = clientUser || (!!shown && !shown.home);
  const pageBilling = clientKnown ? billing : null;
  // On White-label (a trial included), or while the account still has client calendars.
  const showClients = !!clients && (onWhiteLabel(billing) || clients.calendars.length > 1);
  const viewing = client && shown ? { name: shown.business_name || shown.slug, onBack: backToClients } : null;

  return (
    <Shell
      key={state.calendar.id}
      calendar={state.calendar}
      google={google}
      billing={billing}
      path={path}
      navigate={navigate}
      onNewEntry={() => setEntry({})}
      onSignOut={signOut}
      client={client || !clientKnown}
      paused={paused}
      showClients={showClients && !clientUser}
      viewing={clientUser ? null : viewing}
      accountLink={!!state.account}
      clientUser={clientUser}
    >
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
        <Notifications {...page} billing={pageBilling} paused={paused} />
      ) : path === "/admin/branding" ? (
        <Branding
          {...page}
          billing={pageBilling}
          footerHidden={onWhiteLabel(pageBilling) || paused || !!state.calendar.access?.footer_hidden}
          paused={paused}
          clientUser={clientUser}
        />
      ) : path === "/admin/share" ? (
        <Share {...page} />
      ) : path === "/admin/google" ? (
        <Google {...page} google={google} onGoogle={setGoogle} billing={pageBilling} paused={paused} canUpgrade={!clientUser} />
      ) : path === "/admin/account" && state.account ? (
        <Account account={state.account} notify={setToast} onAccount={(account) => setState({ kind: "ready", calendar: state.calendar, account })} />
      ) : path === "/admin/clients" && clients ? (
        <Clients clients={clients} onOpen={openClient} onAdd={canAddClients(billing) ? addClient : null} onChanged={reloadClients} notify={setToast} />
      ) : path === "/admin/plan" && billing?.enabled ? (
        <Plan billing={billing} reload={loadBilling} clients={clients ?? null} />
      ) : (path === "/admin/plan" && !billing) || (path === "/admin/clients" && clients === undefined) ? null : known ? (
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
      {adding && (
        <AddClient
          zone={clients?.calendars.find((x) => x.home)?.time_zone ?? state.calendar.time_zone}
          onClose={() => setAdding(false)}
          onAdded={(created) => {
            setAdding(false);
            setToast({ text: `Added ${created.branding.business_name}. Set up its services and hours.` });
            // A working booking page from the start; failures don't block.
            void switchClient(created.id, "/admin/services", () =>
              Promise.allSettled([adminApi.saveWeekly(DEFAULT_WEEK), adminApi.createService(FIRST_SERVICE)]),
            );
          }}
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
                else if (to === ADD_CLIENT) {
                  // The edits are dropped by closing this page; the new client opens once added.
                  go("/admin");
                  setAdding(true);
                } else if (typeof to === "object") void switchClient(to.client, to.to);
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
