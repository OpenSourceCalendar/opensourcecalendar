import type { Service } from "../api";
import { formatDuration, formatPrice } from "../time";

export function ServiceList({ services, selectedId, onSelect }: { services: Service[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="services" role="group" aria-label="Services">
      {services.map((s) => {
        const on = s.id === selectedId;
        return (
          <button key={s.id} type="button" aria-pressed={on} className="service" onClick={() => onSelect(s.id)}>
            <span className="service-main">
              <span className="service-name">{s.name}</span>
              {s.description && <span className="service-desc">{s.description}</span>}
              <span className="service-meta">
                <span className="chip">{formatDuration(s.duration_min)}</span>
                <span className="service-price">{formatPrice(s.price_cents, s.currency)}</span>
              </span>
            </span>
            <span className="radio-dot" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
