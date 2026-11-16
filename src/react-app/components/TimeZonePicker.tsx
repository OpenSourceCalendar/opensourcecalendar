import { useId, useMemo, useState } from "react";
import { allZones, visitorZone, zoneCity, zoneLabel, zoneOffset } from "../time";

/** "Times shown in Pacific Time · Change", opening an inline zone picker. */
export function TimeZonePicker({ zone, businessZone, onChange }: { zone: string; businessZone: string; onChange: (zone: string) => void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const mine = visitorZone();
  const options = useMemo(() => {
    if (!open) return [];
    const top = [...new Set([businessZone, mine, zone])];
    const rest = allZones().filter((z) => !top.includes(z));
    const opt = (z: string) => ({ value: z, label: `${zoneCity(z)} · ${zoneLabel(z)} (${zoneOffset(z)})` });
    return [top.map(opt), rest.map(opt)] as const;
  }, [open, businessZone, mine, zone]);

  const sameAsBusiness = zoneOffset(zone) === zoneOffset(businessZone);
  return (
    <div className="tz">
      <p className="tz-line">
        Times shown in <strong>{zoneLabel(zone)}</strong>
        <span aria-hidden="true"> · </span>
        <button type="button" className="link" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {open ? "Done" : "Change"}
        </button>
      </p>
      {!sameAsBusiness && <p className="tz-note">The business is in {zoneLabel(businessZone)}.</p>}
      {open && options.length > 0 && (
        <div className="tz-panel" id={id}>
          <label className="label" htmlFor={`${id}-select`}>
            Time zone
          </label>
          <select
            id={`${id}-select`}
            className="input"
            value={zone}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(false);
            }}
          >
            <optgroup label="Suggested">
              {options[0].map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="All time zones">
              {options[1].map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      )}
    </div>
  );
}
