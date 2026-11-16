import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

/**
 * A modal dialog: focus moves in and is trapped, Esc and the scrim close it,
 * and focus returns to where it was. `kind` picks the shape:
 * "modal" is centered (full screen on phones), "panel" is a right-hand side panel (bottom sheet on phones).
 */
export function Dialog({
  kind,
  title,
  onClose,
  children,
}: {
  kind: "modal" | "panel";
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // Focus can fall out when the focused button is removed (e.g. after "Cancel it"); pull it back in.
      if (!box.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && (active === first || active === box.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      if (before?.isConnected) before.focus();
    };
  }, []);

  return (
    <div className={`dialog-layer dialog-${kind}`}>
      <button type="button" className="dialog-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className="dialog-box" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={box}>
        <header className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}

/** A read-only link with a Copy button. */
export function CopyLink({ url, label: name = "Customer's manage link" }: { url: string; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const label = useRef<HTMLSpanElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard access can be blocked inside an iframe; select it so the owner can copy by hand.
      input.current?.select();
      if (label.current) label.current.textContent = "Press Ctrl+C to copy";
      return;
    }
    if (label.current) label.current.textContent = "Copied";
  }

  return (
    <div className="copy-link">
      <input ref={input} className="input" readOnly value={url} aria-label={name} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn btn-secondary" onClick={copy}>
        Copy link
      </button>
      <span ref={label} className="copy-note" role="status" />
    </div>
  );
}
