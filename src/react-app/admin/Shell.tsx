import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AdminCalendar, BillingInfo, GoogleStatus } from "./api";
import { Banners } from "./Banners";
import { Icon, type IconName } from "./Icon";
import { canSignOut } from "./session";

export const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: "/admin", label: "Dashboard", icon: "dashboard" },
  { path: "/admin/schedule", label: "Schedule", icon: "schedule" },
  { path: "/admin/services", label: "Services", icon: "services" },
  { path: "/admin/availability", label: "Availability", icon: "availability" },
  { path: "/admin/customers", label: "Customers", icon: "customers" },
  { path: "/admin/notifications", label: "Notifications", icon: "bell" },
  { path: "/admin/google", label: "Google Calendar", icon: "google" },
  { path: "/admin/branding", label: "Branding", icon: "branding" },
  { path: "/admin/share", label: "Share & Promote", icon: "share" },
];
/** Only shown when billing is on (hosted accounts). */
export const PLAN_NAV: (typeof NAV)[number] = { path: "/admin/plan", label: "Plan", icon: "card" };

/** Left menu on wide screens; a top bar with a slide-over menu on phones. */
export function Shell({
  calendar,
  google,
  billing,
  path,
  navigate,
  onNewEntry,
  onSignOut,
  children,
}: {
  calendar: AdminCalendar;
  /** Null while loading. */
  google: GoogleStatus | null;
  /** Null while loading. */
  billing: BillingInfo | null;
  path: string;
  navigate: (path: string) => void;
  onNewEntry: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  const name = calendar.branding.business_name || "Your calendar";
  const nav = billing?.enabled ? [...NAV, PLAN_NAV] : NAV;
  // A page under a menu item (a customer's page) keeps that item lit. The dashboard only matches itself.
  const current = nav.find((n) => n.path === path || (n.path !== "/admin" && path.startsWith(`${n.path}/`)));

  useEffect(() => {
    if (!menuOpen) return;
    side.current?.querySelector<HTMLElement>("a[aria-current], a")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    menuButton.current?.focus();
  }

  function go(e: MouseEvent, to: string) {
    // Let the browser handle open-in-new-tab and friends.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setMenuOpen(false);
    navigate(to);
  }

  return (
    <div className="admin">
      <header className="admin-top">
        <button
          ref={menuButton}
          type="button"
          className="icon-btn"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          aria-controls="admin-menu"
          onClick={() => setMenuOpen(true)}
        >
          <Icon name="menu" />
        </button>
        <span className="admin-top-title">{current?.label ?? name}</span>
        <button type="button" className="icon-btn admin-top-new" aria-label="New entry" onClick={onNewEntry}>
          <Icon name="plus" />
        </button>
      </header>

      {menuOpen && <button type="button" className="admin-scrim" aria-label="Close menu" tabIndex={-1} onClick={closeMenu} />}

      <aside ref={side} id="admin-menu" className={menuOpen ? "admin-side open" : "admin-side"}>
        <div className="admin-brand">
          <span className="tile" aria-hidden="true">
            {name.charAt(0).toUpperCase()}
          </span>
          <span className="admin-brand-name">{name}</span>
          <button type="button" className="icon-btn admin-side-close" aria-label="Close menu" onClick={closeMenu}>
            <Icon name="close" />
          </button>
        </div>

        <nav className="admin-nav" aria-label="Calendar">
          {nav.map((item) => (
            <a
              key={item.path}
              href={item.path}
              aria-current={item === current ? "page" : undefined}
              onClick={(e) => go(e, item.path)}
            >
              <Icon name={item.icon} />
              {item.label}
            </a>
          ))}
        </nav>

        <div className="admin-side-foot">
          {google?.configured &&
            (google.status === "active" ? (
              <p className="status-box">
                <span className="status-dot is-ok" aria-hidden="true" />
                Google Calendar connected
              </p>
            ) : (
              <a
                className={`status-box status-link${google.status === "broken" ? " is-warn" : ""}`}
                href="/admin/google"
                onClick={(e) => go(e, "/admin/google")}
              >
                <span className={`status-dot${google.status === "broken" ? " is-warn" : ""}`} aria-hidden="true" />
                {google.status === "broken" ? "Google Calendar needs reconnecting" : "Google Calendar: not connected"}
              </a>
            ))}
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setMenuOpen(false);
              onNewEntry();
            }}
          >
            <Icon name="plus" />
            New Entry
          </button>
          {canSignOut() && (
            <button type="button" className="link muted side-signout" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main className="admin-main">
        <Banners billing={billing} navigate={navigate} />
        <div className="admin-main-inner">{children}</div>
      </main>
    </div>
  );
}

export function ComingSoon({ title }: { title: string }) {
  return (
    <>
      <h1 className="admin-title">{title}</h1>
      <div className="admin-empty">
        <p className="sub">Coming in the next update</p>
        <p className="muted small">This part of your calendar isn't ready yet.</p>
      </div>
    </>
  );
}
