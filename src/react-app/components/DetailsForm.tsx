import type { Field } from "../api";

export interface Details {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  note: string;
  consent: boolean;
}

export const emptyDetails: Details = { first_name: "", last_name: "", email: "", phone: "", note: "", consent: false };

export type FieldErrors = Partial<Record<Field, string>>;

const FIELDS: { key: Field; label: string; type: string; autoComplete: string; placeholder: string; inputMode?: "email" | "tel" }[] = [
  { key: "first_name", label: "First name", type: "text", autoComplete: "given-name", placeholder: "" },
  { key: "last_name", label: "Last name", type: "text", autoComplete: "family-name", placeholder: "" },
  { key: "email", label: "Email", type: "email", autoComplete: "email", placeholder: "you@example.com", inputMode: "email" },
  { key: "phone", label: "Phone", type: "tel", autoComplete: "tel", placeholder: "(503) 555-0123", inputMode: "tel" },
];

/** Client-side checks that match the server's. Returns a message per bad field. */
export function validate(d: Details, required: Record<Field, boolean>): FieldErrors {
  const e: FieldErrors = {};
  for (const f of FIELDS) if (required[f.key] && !d[f.key].trim()) e[f.key] = `Please enter your ${f.label.toLowerCase()}.`;
  if (!d.phone.trim() && !d.email.trim() && !e.phone && !e.email) e.phone = "Please enter a phone number or an email.";
  if (d.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) e.email = "That email doesn't look right.";
  const digits = d.phone.replace(/\D/g, "").length;
  if (d.phone.trim() && (digits < 7 || digits > 15)) e.phone = "That phone number doesn't look right.";
  return e;
}

interface Props {
  value: Details;
  onChange: (d: Details) => void;
  required: Record<Field, boolean>;
  errors: FieldErrors;
  consentWording: string;
}

export function DetailsForm({ value, onChange, required, errors, consentWording }: Props) {
  const set = (patch: Partial<Details>) => onChange({ ...value, ...patch });
  const eitherNeeded = !required.phone && !required.email;
  return (
    <div className="form">
      <div className="form-row">
        {FIELDS.slice(0, 2).map((f) => (
          <Input key={f.key} f={f} value={value[f.key]} required={required[f.key]} error={errors[f.key]} onChange={(v) => set({ [f.key]: v })} />
        ))}
      </div>
      {FIELDS.slice(2).map((f) => (
        <Input key={f.key} f={f} value={value[f.key]} required={required[f.key]} error={errors[f.key]} onChange={(v) => set({ [f.key]: v })} />
      ))}
      {eitherNeeded && <p className="hint">We need a phone number or an email to reach you.</p>}

      {value.phone.trim() && (
        <label className="consent">
          <input type="checkbox" checked={value.consent} onChange={(e) => set({ consent: e.target.checked })} />
          <span>{consentWording}</span>
        </label>
      )}

      <div className="field">
        <label className="label" htmlFor="f-note">
          Notes <span className="opt">(optional)</span>
        </label>
        <textarea id="f-note" className="input" rows={3} maxLength={2000} placeholder="Anything we should know?" value={value.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
    </div>
  );
}

function Input({ f, value, required, error, onChange }: { f: (typeof FIELDS)[number]; value: string; required: boolean; error?: string; onChange: (v: string) => void }) {
  const id = `f-${f.key}`;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {f.label} {required ? <span className="req" aria-hidden="true">*</span> : <span className="opt">(optional)</span>}
      </label>
      <input
        id={id}
        name={f.key}
        className="input"
        type={f.type}
        inputMode={f.inputMode}
        autoComplete={f.autoComplete}
        placeholder={f.placeholder}
        value={value}
        required={required}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <p className="field-error" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}
