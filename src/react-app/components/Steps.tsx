/** "Service › Date & Time › Info" with a thin progress bar. `current` is an index into `labels`. */
export function Steps({ labels, current }: { labels: string[]; current: number }) {
  const pct = ((current + 1) / labels.length) * 100;
  return (
    <nav className="steps" aria-label="Booking steps">
      <ol>
        {labels.map((label, i) => (
          <li key={label} className={i < current ? "done" : i === current ? "current" : undefined} aria-current={i === current ? "step" : undefined}>
            {label}
          </li>
        ))}
      </ol>
      <div className="steps-bar" aria-hidden="true">
        <span style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </nav>
  );
}
