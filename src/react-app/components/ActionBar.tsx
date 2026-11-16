import type { ReactNode } from "react";

/** Sticky bottom bar holding the step's primary button, with an optional note (e.g. the picked time) beside it. */
export function ActionBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="action-bar">
      <div className={note ? "action-bar-inner has-note" : "action-bar-inner"}>
        {note && (
          <p className="action-note" aria-live="polite">
            {note}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
