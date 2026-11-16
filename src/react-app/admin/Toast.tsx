import { useEffect } from "react";

export interface ToastMessage {
  text: string;
  error?: boolean;
  undo?: () => void;
}

export type Notify = (toast: ToastMessage) => void;

/** One short message at the bottom of the screen. Goes away by itself after 8 seconds. */
export function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onClose, 8000);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  // The live region stays in the page so screen readers announce a message when it appears.
  return (
    <div aria-live={toast?.error ? "assertive" : "polite"}>
      {toast && <ToastBox toast={toast} onClose={onClose} />}
    </div>
  );
}

function ToastBox({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  return (
    <div className={toast.error ? "toast is-error" : "toast"}>
      <span>{toast.text}</span>
      {toast.undo && (
        <button type="button" className="toast-action" onClick={toast.undo}>
          Undo
        </button>
      )}
      <button type="button" className="toast-action" aria-label="Dismiss" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
