/** The Save bar for screens edited as a whole form. Save is greyed out until something changes. */
export function SaveBar({
  dirty,
  saving,
  error,
  blocked,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  error?: string;
  /** Why saving isn't allowed right now (e.g. a field is wrong), if anything. */
  blocked?: string;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const message = error || (dirty ? blocked : "");
  return (
    <div className="savebar">
      <div className="savebar-inner">
        <p className={message ? "savebar-text is-error" : "savebar-text"} aria-live="polite">
          {message || (dirty ? "Unsaved changes" : "All changes saved")}
        </p>
        {dirty && (
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onDiscard}>
            Discard
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!dirty || saving || !!blocked} onClick={onSave}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
