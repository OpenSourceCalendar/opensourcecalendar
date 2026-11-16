import qrcode from "qrcode-generator";
import { useMemo, useState, type FormEvent } from "react";
import { brandVars } from "../theme";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText } from "./api";
import { CopyLink, Dialog } from "./Dialog";
import { cleanSlug, SLUG_HINT, SLUG_RE, useSlugCheck } from "./slug";

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const QUIET = 4; // blank modules around the code, so cameras can find it

/** The QR code as one SVG path of dark squares. Always dark on white so it scans. */
function qrSvg(text: string): { size: number; path: string } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let path = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + QUIET},${r + QUIET}h1v1h-1z`;
  return { size: n + QUIET * 2, path };
}

const WHERE: [string, string, string?][] = [
  ["Facebook", "Add it to your Page's action button, or put it in a post.", "https://www.facebook.com/"],
  ["Instagram", "Put it in your bio.", "https://www.instagram.com/"],
  ["Google Business Profile", "Edit profile → Booking → add your link.", "https://business.google.com/"],
  ["Nextdoor", "Add it to your business page.", "https://nextdoor.com/"],
];

export function Share({ calendar, notify, onCalendar }: PageProps) {
  const link = `${window.location.origin}/book/${calendar.slug}`;
  const colors = brandVars(calendar.branding.color);
  const qr = useMemo(() => qrSvg(link), [link]);
  const [changing, setChanging] = useState(false);

  const buttonCode = `<a href="${attr(link)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;border-radius:9px;background:${colors["--brand"]};color:${colors["--on-brand"]};font:600 16px system-ui,sans-serif;text-decoration:none">Book an appointment</a>`;
  const frameCode = `<iframe src="${attr(link)}" title="Book an appointment" style="width:100%;max-width:520px;height:760px;border:0" loading="lazy"></iframe>`;

  function downloadPng() {
    const px = 1024;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = px;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = "#111";
    // Whole pixels per square, centred, so every edge is sharp.
    const unit = Math.floor(px / qr.size);
    const offset = Math.floor((px - unit * qr.size) / 2);
    ctx.translate(offset, offset);
    ctx.scale(unit, unit);
    ctx.fill(new Path2D(qr.path));
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${calendar.slug}-qr.png`;
      // Some browsers only download from a link that's in the page, and need the address to outlive the click.
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  }

  return (
    <>
      <header className="admin-band">
        <h1 className="admin-title">Share &amp; Promote</h1>
      </header>

      <section className="card" aria-labelledby="sh-link">
        <h2 className="card-title" id="sh-link">
          Your booking link
        </h2>
        <p className="big-link">{link}</p>
        <CopyLink url={link} label="Your booking link" />
        <div className="link-actions">
          <a className="btn btn-secondary btn-auto" href={link} target="_blank" rel="noopener">
            Open
          </a>
          <button type="button" className="link muted" onClick={() => setChanging(true)}>
            Change your link
          </button>
        </div>
      </section>

      <section className="card" aria-labelledby="sh-embed">
        <h2 className="card-title" id="sh-embed">
          Add to your website
        </h2>
        <CodeBox title="A button that opens your booking page" code={buttonCode} notify={notify} />
        <CodeBox title="Your booking page inside your site" code={frameCode} notify={notify} />
      </section>

      <section className="card" aria-labelledby="sh-qr">
        <h2 className="card-title" id="sh-qr">
          QR code
        </h2>
        <div className="qr-row">
          <svg className="qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label={`QR code for ${link}`} shapeRendering="crispEdges">
            <rect width={qr.size} height={qr.size} fill="#fff" />
            <path d={qr.path} fill="#111" />
          </svg>
          <div className="stack">
            <p className="muted">For trucks, cards and flyers. Scanning it opens your booking page.</p>
            <button type="button" className="btn btn-secondary btn-auto" onClick={downloadPng}>
              Download PNG
            </button>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="sh-where">
        <h2 className="card-title" id="sh-where">
          Share everywhere
        </h2>
        <ul className="rows">
          {WHERE.map(([name, how, url]) => (
            <li key={name} className="row">
              <span className="row-main share-how">
                <strong>{name}</strong>
                <span className="muted small">{how}</span>
              </span>
              {url && (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              )}
            </li>
          ))}
        </ul>
      </section>

      {changing && (
        <SlugDialog
          current={calendar.slug}
          onClose={() => setChanging(false)}
          onSaved={(next) => {
            setChanging(false);
            onCalendar(next);
            notify({ text: "Your booking link changed" });
          }}
        />
      )}
    </>
  );
}

function CodeBox({ title, code, notify }: { title: string; code: string; notify: PageProps["notify"] }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      notify({ text: "Code copied" });
    } catch {
      notify({ text: "Select the code and copy it by hand.", error: true });
    }
  }
  return (
    <div className="field">
      <span className="label">{title}</span>
      <textarea className="input code" readOnly rows={3} value={code} aria-label={title} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn btn-secondary btn-auto" onClick={copy}>
        Copy code
      </button>
    </div>
  );
}

function SlugDialog({ current, onClose, onSaved }: { current: string; onClose: () => void; onSaved: (calendar: PageProps["calendar"]) => void }) {
  const [slug, setSlug] = useState(current);
  const state = useSlugCheck(slug, current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bad = state === "invalid" || state === "taken";
  const ready = SLUG_RE.test(slug) && slug !== current && state !== "taken";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      onSaved(await adminApi.updateCalendar({ slug }));
    } catch (err) {
      const text = adminErrorText(err);
      // Reserved words pass the live check but the server refuses them.
      setError(text.startsWith("Something in the form") ? "That link can't be used. Try a different one." : text);
      setBusy(false);
    }
  }

  return (
    <Dialog kind="modal" title="Change your link" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="sl-slug">
            Booking link
          </label>
          <input
            id="sl-slug"
            className="input"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={40}
            value={slug}
            aria-invalid={bad}
            aria-describedby="sl-hint"
            onChange={(e) => setSlug(cleanSlug(e.target.value))}
          />
          <p id="sl-hint" className={bad ? "field-error" : state === "available" ? "slug-ok" : "hint"} aria-live="polite">
            {SLUG_HINT[state]}
          </p>
          <p className="slug-preview">
            {window.location.origin}/book/<strong>{slug || "your-business"}</strong>
          </p>
        </div>
        <p className="info">
          Your old link will stop working. Anything you've already shared or printed, including QR codes, will need the new link.
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div className="two">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy ? "Changing…" : "Change link"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
