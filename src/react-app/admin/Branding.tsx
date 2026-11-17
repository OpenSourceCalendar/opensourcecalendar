import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Service } from "../api";
import { Header } from "../components/Header";
import { PoweredBy } from "../components/PoweredBy";
import { ServiceList } from "../components/ServiceList";
import { brandVars, type PageStyle } from "../theme";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText, onFree, type BillingInfo } from "./api";
import { SaveBar } from "./SaveBar";
import { trimTransparent } from "./trim";

const PRESETS: [string, string][] = [
  ["#2d6a4f", "Green"],
  ["#1d4ed8", "Blue"],
  ["#7c3aed", "Purple"],
  ["#b91c1c", "Red"],
  ["#c2410c", "Orange"],
  ["#334155", "Slate"],
];
const STYLES: [PageStyle, string, string][] = [
  ["classic", "Classic", "Color band on top, rounded"],
  ["clean", "Clean", "White and minimal"],
  ["soft", "Soft", "Tinted and extra round"],
  ["bold", "Bold", "Full color, strong outlines"],
  ["midnight", "Midnight", "Dark"],
];
const HEX = /^#[0-9a-fA-F]{6}$/;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const LIMITS = { logo: 2, hero: 5 }; // MB

type Kind = "logo" | "hero";

export function Branding({ calendar, notify, setDirty, onCalendar, billing }: PageProps & { billing: BillingInfo | null }) {
  const b = calendar.branding;
  // On Free the footer always shows (the server adds it), so the box shows that without changing the saved setting.
  const forcedFooter = onFree(billing);
  const savedForm = { business_name: b.business_name, phone: b.phone, tagline: b.tagline, color: b.color, style: b.style, powered_by: calendar.rules.powered_by };
  const [form, setForm] = useState(savedForm);
  const [hexText, setHexText] = useState(b.color);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [uploading, setUploading] = useState<Kind | null>(null);
  const [imageError, setImageError] = useState<{ kind: Kind; text: string } | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm);
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);

  useEffect(() => {
    // The preview shows what customers see: no hidden services.
    adminApi.services().then((r) => setServices(r.services.filter((s) => !s.hidden)), () => {});
  }, []);

  function setColor(color: string) {
    set("color", color);
    setHexText(color);
  }

  async function save() {
    if (saving || uploading) return;
    setSaving(true);
    setSaveError("");
    try {
      const { powered_by, ...branding } = form;
      const next = await adminApi.updateCalendar({ branding, rules: { powered_by } });
      onCalendar(next);
      notify({ text: "Saved. Your booking page is updated." });
    } catch (e) {
      setSaveError(adminErrorText(e));
    }
    setSaving(false);
  }

  async function upload(kind: Kind, file: File | undefined) {
    if (!file || uploading || saving) return; // a save in flight would hand back the old image
    setImageError(null);
    if (!IMAGE_TYPES.includes(file.type)) return setImageError({ kind, text: "Use a PNG, JPEG or WebP image." });
    if (file.size > LIMITS[kind] * 1024 * 1024) return setImageError({ kind, text: `That file is too big (max ${LIMITS[kind]} MB).` });
    setUploading(kind);
    try {
      const trimmed = kind === "logo" ? await trimTransparent(file) : file;
      // A re-encoded PNG can come out bigger than the original; keep the original then.
      await adminApi.uploadImage(kind, trimmed.size <= LIMITS[kind] * 1024 * 1024 ? trimmed : file);
      onCalendar(await adminApi.calendar());
      notify({ text: kind === "logo" ? "Logo updated" : "Hero photo updated" });
    } catch (e) {
      setImageError({ kind, text: adminErrorText(e) });
    }
    setUploading(null);
  }

  async function removeImage(kind: Kind) {
    if (uploading) return;
    setUploading(kind);
    try {
      await adminApi.removeImage(kind);
      onCalendar(await adminApi.calendar());
    } catch (e) {
      setImageError({ kind, text: adminErrorText(e) });
    }
    setUploading(null);
  }

  const preview = { ...b, business_name: form.business_name, phone: form.phone, tagline: form.tagline, color: form.color };

  return (
    <>
      <header className="admin-band">
        <h1 className="admin-title">Branding</h1>
      </header>
      <div className="brand-cols">
        <div className="brand-form">
          <section className="card">
            <h2 className="card-title">Business identity</h2>
            <div className="field">
              <label className="label" htmlFor="br-name">
                Business name
              </label>
              <input id="br-name" className="input" maxLength={100} value={form.business_name} onChange={(e) => set("business_name", e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="br-phone">
                Business phone
              </label>
              <input id="br-phone" className="input" type="tel" maxLength={40} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="br-tagline">
                Tagline
              </label>
              <input id="br-tagline" className="input" maxLength={200} value={form.tagline} onChange={(e) => set("tagline", e.target.value)} />
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">Page style</h2>
            <div className="style-choices" role="radiogroup" aria-label="Page style">
              {STYLES.map(([id, name, hint]) => (
                <label key={id} className="style-choice">
                  <input type="radio" name="page-style" checked={form.style === id} onChange={() => set("style", id)} />
                  <span>
                    <strong>{name}</strong>
                    <span className="muted small">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="hint">Changes your booking page and your customers' change or cancel page. Any color works with any style.</p>
          </section>

          <section className="card">
            <h2 className="card-title">Brand color</h2>
            <div className="swatches" role="group" aria-label="Brand color">
              {PRESETS.map(([hex, name]) => (
                <label key={hex} className="swatch" style={{ "--svc": hex } as CSSProperties}>
                  <input type="radio" name="brand-color" checked={form.color.toLowerCase() === hex} onChange={() => setColor(hex)} />
                  <span className="sr-only">{name}</span>
                </label>
              ))}
              <label className="swatch swatch-custom" style={{ "--svc": form.color } as CSSProperties}>
                <input type="color" value={form.color} onChange={(e) => setColor(e.target.value)} />
                <span className="sr-only">Custom color</span>
              </label>
              <input
                className="input hex-input"
                aria-label="Color code"
                maxLength={7}
                value={hexText}
                aria-invalid={!HEX.test(hexText)}
                onChange={(e) => {
                  setHexText(e.target.value);
                  if (HEX.test(e.target.value)) set("color", e.target.value.toLowerCase());
                }}
              />
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">Logo and hero photo</h2>
            {(["logo", "hero"] as const).map((kind) => {
              const url = kind === "logo" ? b.logo_url : b.hero_url;
              return (
                <ImageField
                  key={kind}
                  label={kind === "logo" ? "Logo" : "Hero photo"}
                  hint={kind === "logo" ? "Shown beside your name. PNG, JPEG or WebP, up to 2 MB." : "A wide photo at the top of your booking page. Up to 5 MB."}
                  url={url}
                  wide={kind === "hero"}
                  busy={uploading === kind}
                  error={imageError?.kind === kind ? imageError.text : ""}
                  onFile={(file) => upload(kind, file)}
                  onRemove={() => removeImage(kind)}
                />
              );
            })}
            <p className="hint">Images save as soon as you choose them.</p>
          </section>

          <section className="card">
            <label className="check-row">
              <input type="checkbox" checked={forcedFooter || form.powered_by} disabled={forcedFooter} onChange={(e) => set("powered_by", e.target.checked)} />
              Show "Powered by Open Source Calendar" at the bottom
            </label>
            {forcedFooter && <p className="hint">Pro removes the footer.</p>}
          </section>
          <p className="muted small">Save to update your live booking page.</p>
        </div>

        <aside className="brand-preview" aria-label="Preview">
          <p className="panel-label">Preview</p>
          {/* Its own brand variables, so the unsaved color shows here without recoloring the admin. */}
          <div className="phone" data-style={form.style} style={brandVars(form.color, form.style) as CSSProperties} aria-hidden="true" {...{ inert: "" }}>
            <Header branding={preview}>
              <h2 className="title">Choose a service</h2>
            </Header>
            <div className="content">
              {services.length ? <ServiceList services={services.slice(0, 3)} selectedId={null} onSelect={() => {}} /> : <p className="muted">Your services will show here.</p>}
            </div>
            <PoweredBy show={forcedFooter || form.powered_by} />
          </div>
        </aside>
      </div>

      <SaveBar
        dirty={dirty}
        saving={saving}
        error={saveError}
        blocked={uploading ? "Wait for the upload to finish." : !HEX.test(hexText) ? "The color code should look like #1d4ed8." : ""}
        onSave={save}
        onDiscard={() => {
          setForm(savedForm);
          setHexText(savedForm.color);
          setSaveError("");
        }}
      />
    </>
  );
}

function ImageField({
  label,
  hint,
  url,
  wide,
  busy,
  error,
  onFile,
  onRemove,
}: {
  label: string;
  hint: string;
  url: string | null;
  wide: boolean;
  busy: boolean;
  error: string;
  onFile: (file: File | undefined) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div
        className={`drop${over ? " is-over" : ""}${wide ? " is-wide" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          onFile(e.dataTransfer.files[0]);
        }}
      >
        {url ? <img src={url} alt={`Current ${label.toLowerCase()}`} /> : <span className="muted small">Drop an image here</span>}
      </div>
      <div className="drop-actions">
        <button type="button" className="btn btn-secondary btn-auto" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Working…" : url ? "Replace" : "Choose file"}
        </button>
        {url && (
          <button type="button" className="link muted" disabled={busy} onClick={onRemove}>
            Remove
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          aria-label={label}
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = ""; // choosing the same file again still fires
          }}
        />
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="hint">{hint}</p>
      )}
    </div>
  );
}
