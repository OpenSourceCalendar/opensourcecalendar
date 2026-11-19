import { useState } from "react";

/** A password field with Show/Hide. Paste and password managers work (no blocking, ever). */
export function PasswordInput({ id, value, onChange, autoComplete, invalid }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="password-field">
      <input id={id} className="input" type={show ? "text" : "password"} autoComplete={autoComplete} value={value}
        aria-invalid={invalid} spellCheck={false} autoCapitalize="off" onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="link small" aria-pressed={show} aria-controls={id} onClick={() => setShow((s) => !s)}>
        {show ? "Hide" : "Show"}
      </button>
    </div>
  );
}
