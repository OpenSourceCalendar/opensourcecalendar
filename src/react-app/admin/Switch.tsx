import type { ReactNode } from "react";

/** An on/off switch. `label` names it for screen readers when there's no visible text beside it. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
    </label>
  );
}

/** One setting: what it is and what it does on the left, the control on the right. */
export function Setting({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <p className="setting-title">{title}</p>
        {help && <p className="muted small">{help}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}
