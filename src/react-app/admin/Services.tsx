import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import { ApiError } from "../api";
import { formatDuration, formatPrice } from "../time";
import type { PageProps } from "./AdminApp";
import { adminApi, adminErrorText, type AdminService, type LocationType, type ServiceInput } from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

const LOCATIONS: { value: LocationType; label: string; detail: string }[] = [
  { value: "phone", label: "Phone call", detail: "Details (optional)" },
  { value: "video", label: "Video call", detail: "Video link" },
  { value: "their_place", label: "At their place", detail: "Details (optional)" },
  { value: "business", label: "At the business", detail: "Address" },
  { value: "other", label: "Other", detail: "Details" },
];
const locationLabel = (s: AdminService) =>
  [LOCATIONS.find((l) => l.value === s.location_type)?.label, s.location_text].filter(Boolean).join(" · ");

const COLORS: [string, string][] = [
  ["#4f46e5", "Indigo"],
  ["#2563eb", "Blue"],
  ["#0d9488", "Teal"],
  ["#16a34a", "Green"],
  ["#ca8a04", "Gold"],
  ["#ea580c", "Orange"],
  ["#dc2626", "Red"],
  ["#9333ea", "Purple"],
];
const LENGTHS = [15, 30, 45, 60, 90, 120];

const BLANK: ServiceInput = {
  name: "",
  description: "",
  duration_min: 30,
  price_cents: null,
  color: COLORS[0][0],
  location_type: "phone",
  location_text: "",
  hidden: false,
  is_call_default: false,
};

export function Services({ notify }: PageProps) {
  const [services, setServices] = useState<AdminService[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<AdminService | "new" | null>(null);
  const [changes, setChanges] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const cards = useRef(new Map<string, HTMLLIElement>());
  // The order while dragging; saved when the pointer lifts.
  const order = useRef<AdminService[]>([]);

  useEffect(() => {
    let live = true;
    adminApi.services().then(
      (r) => live && (setServices(r.services), setError("")),
      (e) => live && setError(adminErrorText(e)),
    );
    return () => {
      live = false;
    };
  }, [changes]);

  async function saveOrder(next: AdminService[]) {
    setServices(next);
    try {
      await adminApi.orderServices(next.map((s) => s.id));
    } catch (e) {
      notify({ text: adminErrorText(e), error: true });
      setChanges((n) => n + 1);
    }
  }

  function move(index: number, by: number) {
    if (!services) return;
    const to = index + by;
    if (to < 0 || to >= services.length) return;
    const next = [...services];
    [next[index], next[to]] = [next[to], next[index]];
    void saveOrder(next);
  }

  function onDragStart(e: PointerEvent<HTMLButtonElement>, id: string) {
    if (e.button !== 0 || e.pointerType === "touch" || !services) return; // touch uses the arrows
    e.preventDefault();
    order.current = services;
    setDragId(id);
    // Listen on the window: the card itself is moved in the page as it's reordered, which would drop events bound to it.
    const onMove = (ev: globalThis.PointerEvent) => {
      const list = order.current;
      const from = list.findIndex((s) => s.id === id);
      // Swap with a neighbour once the pointer passes its middle.
      for (const to of [from - 1, from + 1]) {
        const rect = cards.current.get(list[to]?.id)?.getBoundingClientRect();
        if (!rect) continue;
        const middle = rect.top + rect.height / 2;
        if (to < from ? ev.clientY < middle : ev.clientY > middle) {
          const next = [...list];
          [next[from], next[to]] = [next[to], next[from]];
          order.current = next;
          setServices(next);
          return;
        }
      }
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      setDragId(null);
      if (order.current !== services) void saveOrder(order.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  return (
    <>
      <header className="page-head admin-band">
        <div>
          <h1 className="admin-title">Services</h1>
          <p className="muted">Services people can book.</p>
        </div>
        <button type="button" className="btn btn-primary btn-auto" onClick={() => setEditing("new")}>
          <Icon name="plus" />
          Add service
        </button>
      </header>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      {!services ? (
        !error && <span className="skeleton block" />
      ) : services.length ? (
        <ul className="svc-list">
          {services.map((s, i) => (
            <li
              key={s.id}
              ref={(el) => void (el ? cards.current.set(s.id, el) : cards.current.delete(s.id))}
              className={`svc-card${dragId === s.id ? " is-dragging" : ""}`}
              style={{ "--svc": s.color } as CSSProperties}
            >
              <button
                type="button"
                className="svc-handle"
                aria-hidden="true"
                tabIndex={-1}
                onPointerDown={(e) => onDragStart(e, s.id)}
              >
                <Icon name="menu" size={18} />
              </button>
              <span className="svc-tile" aria-hidden="true">
                {s.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join("")}
              </span>
              <button type="button" className="svc-main" onClick={() => setEditing(s)}>
                <span className="svc-name">{s.name}</span>
                <span className="svc-badges">
                  <span className="chip">{formatDuration(s.duration_min)}</span>
                  <span className="chip">{formatPrice(s.price_cents, s.currency)}</span>
                  {s.hidden && <span className="chip chip-quiet">Hidden</span>}
                  {s.is_call_default && <span className="chip chip-brand">Default for calls</span>}
                </span>
                <span className="muted small">{locationLabel(s)}</span>
              </button>
              <span className="svc-moves">
                <button type="button" className="icon-btn" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 15l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
                <button type="button" className="icon-btn" aria-label={`Move ${s.name} down`} disabled={i === services.length - 1} onClick={() => move(i, 1)}>
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="admin-empty">
          <p className="sub">No services yet</p>
          <p className="muted small">Add the first thing people can book with you.</p>
        </div>
      )}

      {editing && (
        <ServiceEditor
          service={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(text) => {
            setEditing(null);
            setChanges((n) => n + 1);
            notify({ text });
          }}
        />
      )}
    </>
  );
}

function ServiceEditor({ service, onClose, onSaved }: { service: AdminService | null; onClose: () => void; onSaved: (text: string) => void }) {
  const [form, setForm] = useState<ServiceInput>(() =>
    service
      ? {
          name: service.name,
          description: service.description,
          duration_min: service.duration_min,
          price_cents: service.price_cents,
          color: service.color,
          location_type: service.location_type,
          location_text: service.location_text,
          hidden: service.hidden,
          is_call_default: service.is_call_default,
        }
      : BLANK,
  );
  const [customLength, setCustomLength] = useState(() => !LENGTHS.includes(form.duration_min));
  const [price, setPrice] = useState(() => (service?.price_cents ? (service.price_cents / 100).toFixed(2) : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [badField, setBadField] = useState("");
  // null = not asking; a number = asking, with that many upcoming appointments.
  const [confirmDelete, setConfirmDelete] = useState<number | "unknown" | null>(null);
  const set = <K extends keyof ServiceInput>(key: K, value: ServiceInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const priceNumber = price.trim() === "" ? 0 : Number(price);
  const priceOk = Number.isFinite(priceNumber) && priceNumber >= 0;
  const lengthOk = Number.isInteger(form.duration_min) && form.duration_min >= 5 && form.duration_min <= 1440;
  const ready = !!form.name.trim() && priceOk && lengthOk;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    setBadField("");
    const input: ServiceInput = { ...form, name: form.name.trim(), price_cents: priceNumber ? Math.round(priceNumber * 100) : null };
    try {
      if (service) await adminApi.updateService(service.id, input);
      else await adminApi.createService(input);
      onSaved(service ? "Service saved" : "Service added");
    } catch (err) {
      if (err instanceof ApiError && err.error === "invalid_input") {
        setBadField(err.missing[0] ?? "");
        setError("Check the fields and try again.");
      } else setError(adminErrorText(err));
      setBusy(false);
    }
  }

  async function askDelete() {
    if (!service) return;
    setError("");
    try {
      // Upcoming bookings keep their time, but can't be moved online once the service is gone.
      const now = Date.now();
      const { appointments } = await adminApi.appointments(new Date(now).toISOString(), new Date(now + 730 * 86400000).toISOString(), service.id);
      setConfirmDelete(appointments.filter((a) => a.status === "booked" || a.status === "confirmed").length);
    } catch {
      setConfirmDelete("unknown");
    }
  }

  async function remove() {
    if (!service || busy) return;
    setBusy(true);
    try {
      await adminApi.deleteService(service.id);
      onSaved("Service deleted");
    } catch (err) {
      setError(adminErrorText(err));
      setBusy(false);
    }
  }

  const where = LOCATIONS.find((l) => l.value === form.location_type)!;
  const invalid = (field: string) => badField === field || undefined;

  return (
    <Dialog kind="panel" title={service ? service.name : "Add service"} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="svc-name">
            Name
          </label>
          <input id="svc-name" className="input" maxLength={100} value={form.name} aria-invalid={invalid("name")} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="svc-desc">
            Description <span className="opt">(optional)</span>
          </label>
          <textarea id="svc-desc" className="input" rows={3} maxLength={2000} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </div>

        <div className="form-row">
          <div className="field">
            <label className="label" htmlFor="svc-length">
              Length
            </label>
            <select
              id="svc-length"
              className="input"
              value={customLength ? "custom" : form.duration_min}
              onChange={(e) => {
                const custom = e.target.value === "custom";
                setCustomLength(custom);
                if (!custom) set("duration_min", Number(e.target.value));
              }}
            >
              {LENGTHS.map((m) => (
                <option key={m} value={m}>
                  {formatDuration(m)}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="svc-price">
              Price <span className="opt">(empty = free)</span>
            </label>
            <input
              id="svc-price"
              className="input"
              inputMode="decimal"
              placeholder="Free"
              value={price}
              aria-invalid={!priceOk || invalid("price_cents")}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
        </div>
        {customLength && (
          <div className="field">
            <label className="label" htmlFor="svc-minutes">
              Minutes
            </label>
            <input
              id="svc-minutes"
              className="input"
              type="number"
              min={5}
              max={1440}
              value={form.duration_min || ""}
              aria-invalid={!lengthOk}
              onChange={(e) => set("duration_min", Number(e.target.value))}
            />
            {!lengthOk && <p className="field-error">Between 5 minutes and 24 hours.</p>}
          </div>
        )}

        <fieldset className="fieldset">
          <legend className="label">Color on your calendar</legend>
          <div className="swatches">
            {COLORS.map(([hex, name]) => (
              <label key={hex} className="swatch" style={{ "--svc": hex } as CSSProperties}>
                <input type="radio" name="svc-color" checked={form.color.toLowerCase() === hex} onChange={() => set("color", hex)} />
                <span className="sr-only">{name}</span>
              </label>
            ))}
            <label className="swatch swatch-custom" style={{ "--svc": form.color } as CSSProperties}>
              <input type="color" value={form.color} onChange={(e) => set("color", e.target.value)} />
              <span className="sr-only">Custom color</span>
            </label>
          </div>
        </fieldset>

        <fieldset className="fieldset">
          <legend className="label">Where it happens</legend>
          <div className="radios">
            {LOCATIONS.map((l) => (
              <label key={l.value} className="check-row">
                <input type="radio" name="svc-where" checked={form.location_type === l.value} onChange={() => set("location_type", l.value)} />
                {l.label}
              </label>
            ))}
          </div>
          <input
            className="input"
            aria-label={where.detail}
            placeholder={where.detail}
            maxLength={500}
            value={form.location_text}
            onChange={(e) => set("location_text", e.target.value)}
          />
        </fieldset>

        <div>
          <label className="check-row">
            <input type="checkbox" checked={form.hidden} onChange={(e) => set("hidden", e.target.checked)} />
            Hidden
          </label>
          <p className="hint">Not shown on your booking page. You can still book it yourself from New Entry.</p>
        </div>
        <div>
          <label className="check-row">
            <input type="checkbox" checked={form.is_call_default} onChange={(e) => set("is_call_default", e.target.checked)} />
            Default for calls
          </label>
          <p className="hint">Pre-selected in New Entry. Only one service can be the default.</p>
        </div>

        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
          {busy ? "Saving…" : service ? "Save" : "Add service"}
        </button>

        {service && confirmDelete === null && (
          <button type="button" className="btn btn-danger-outline" onClick={askDelete}>
            Delete service
          </button>
        )}
        {service && confirmDelete !== null && (
          <section className="panel stack" aria-label="Delete service">
            <h3 className="panel-title">Delete {service.name}?</h3>
            <p className="muted small">
              Past appointments keep it.
              {confirmDelete === "unknown" && " Any upcoming appointments keep their time, but customers won't be able to reschedule them online."}
              {typeof confirmDelete === "number" &&
                confirmDelete > 0 &&
                ` ${confirmDelete} upcoming ${confirmDelete === 1 ? "appointment keeps its" : "appointments keep their"} time, but customers won't be able to reschedule ${confirmDelete === 1 ? "it" : "them"} online.`}
            </p>
            <div className="two">
              <button type="button" className="btn btn-secondary" autoFocus onClick={() => setConfirmDelete(null)}>
                Keep it
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
                Delete
              </button>
            </div>
          </section>
        )}
      </form>
    </Dialog>
  );
}
