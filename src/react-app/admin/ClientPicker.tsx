import type { ClientList } from "./api";

/** White-label: which business the screens are for. The agency's own calendar is first. */
export function ClientPicker({
  clients,
  currentId,
  onPick,
  onAdd,
}: {
  clients: ClientList;
  currentId: string;
  onPick: (id: string) => void;
  /** Null when the plan can't add clients (only during a grace month or after). */
  onAdd: (() => void) | null;
}) {
  return (
    <div className="client-picker">
      <label className="label" htmlFor="client-picker">
        Business
      </label>
      <select id="client-picker" className="input" value={currentId} onChange={(e) => onPick(e.target.value)}>
        {clients.calendars.map((c) => (
          <option key={c.id} value={c.id}>
            {`${c.business_name || c.slug}${c.home ? " (your agency)" : ""}${c.paused ? " · paused" : ""}`}
          </option>
        ))}
      </select>
      {onAdd && (
        <button type="button" className="link small" onClick={onAdd}>
          + Add client
        </button>
      )}
    </div>
  );
}
