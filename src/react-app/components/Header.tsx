import type { ReactNode } from "react";
import type { Branding } from "../api";

/**
 * Brand band: logo (or a letter tile), business name and tagline, then `children` (steps, the page title, chips).
 * The business's hero photo, when set, shows faintly under a wash of the brand color. Shows a back arrow when `onBack` is given.
 */
export function Header({ branding, onBack, children }: { branding: Branding; onBack?: () => void; children?: ReactNode }) {
  const name = branding.business_name.trim() || "Book an appointment";
  return (
    <header className={branding.hero_url ? "band has-photo" : "band"}>
      {branding.hero_url && <img className="band-photo" src={branding.hero_url} alt="" />}
      <div className="band-top">
        {onBack && (
          <button type="button" className="band-back" onClick={onBack} aria-label="Back">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {branding.logo_url ? (
          // The name is right beside it, so the logo is decoration to a screen reader.
          <img className="tile tile-logo" src={branding.logo_url} alt="" />
        ) : (
          <span className="tile" aria-hidden="true">
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <div className="band-text">
          <p className="band-name">{name}</p>
          {branding.tagline && <p className="band-tagline">{branding.tagline}</p>}
        </div>
      </div>
      {children}
    </header>
  );
}
