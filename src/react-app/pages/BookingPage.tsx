import { useEffect, useRef, useState } from "react";
import { api, ApiError, errorText, type Booked, type Field, type PublicCalendar } from "../api";
import { applyBrand } from "../theme";
import { formatDate, formatDuration, formatTime, shortDate, visitorZone, zoneLabel } from "../time";
import { ActionBar } from "../components/ActionBar";
import { Confirmed } from "../components/Confirmed";
import { DateTimePicker } from "../components/DateTimePicker";
import { DetailsForm, emptyDetails, validate, type Details, type FieldErrors } from "../components/DetailsForm";
import { Header } from "../components/Header";
import { PoweredBy } from "../components/PoweredBy";
import { ServiceList } from "../components/ServiceList";
import { Steps } from "../components/Steps";
import { Summary } from "../components/Summary";
import { Turnstile } from "../components/Turnstile";
import { NotFound } from "./NotFound";

type Step = "service" | "time" | "info" | "done";
const FIELD_KEYS: Field[] = ["first_name", "last_name", "email", "phone"];

export function BookingPage({ slug }: { slug: string }) {
  const [cal, setCal] = useState<PublicCalendar | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [zone, setZone] = useState(visitorZone);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [details, setDetails] = useState<Details>(emptyDetails);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tsReset, setTsReset] = useState(0);
  const [booked, setBooked] = useState<Booked | null>(null);
  const bookedRef = useRef(false);

  useEffect(() => {
    api.calendar(slug).then(
      (c) => {
        setCal(c);
        applyBrand(c.branding.color, c.branding.style);
        document.title = `Book with ${c.branding.business_name || "us"}`;
        const first: Step = c.services.length === 1 ? "time" : "service";
        if (c.services.length === 1) setServiceId(c.services[0].id);
        setStep(first);
        history.replaceState({ step: first }, "");
      },
      (e) => setLoadError(e instanceof ApiError ? e : new ApiError(0, "network")),
    );
  }, [slug]);

  // The browser Back button walks back through the steps.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      // Once booked, the step entries are stale: keep going back until we leave the page.
      if (bookedRef.current) {
        history.back();
        return;
      }
      const s = (e.state as { step?: Step } | null)?.step;
      if (s) setStep(s);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  if (loadError) return loadError.status === 404 ? <NotFound /> : <ErrorScreen message={errorText(loadError)} />;
  if (!cal) return <LoadingScreen />;

  const service = cal.services.find((s) => s.id === serviceId) ?? null;
  const required = { ...cal.booking.required_fields, first_name: true };
  const labels = cal.services.length > 1 ? ["Service", "Date & Time", "Info"] : ["Date & Time", "Info"];
  const stepIndex = { service: 0, time: 1, info: 2, done: 3 }[step] - (cal.services.length > 1 ? 0 : 1);
  const firstStep: Step = cal.services.length > 1 ? "service" : "time";

  const go = (s: Step) => {
    history.pushState({ step: s }, "");
    setStep(s);
  };

  const filled = FIELD_KEYS.every((k) => !required[k] || details[k].trim()) && (details.phone.trim() || details.email.trim());
  const canBook = !!filled && !submitting && (!cal.turnstile_site_key || !!token);

  async function book() {
    if (!cal || !service || !slot) return;
    const errs = validate(details, required);
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) {
      document.getElementById(`f-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const phone = details.phone.trim();
      const res = await api.book(cal.slug, {
        service_id: service.id,
        start: slot,
        first_name: details.first_name.trim(),
        last_name: details.last_name.trim() || undefined,
        email: details.email.trim() || undefined,
        phone: phone || undefined,
        note: details.note.trim(),
        text_consent: phone && details.consent ? { wording: cal.consent_wording } : undefined,
        turnstile_token: token ?? undefined,
        time_zone: zone,
      });
      bookedRef.current = true;
      setBooked(res);
      history.replaceState({ step: "done" }, "");
      setStep("done");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNotice(errorText(e));
        setSlot(null);
        setReloadKey((n) => n + 1);
        history.back();
      } else if (e instanceof ApiError && e.missing.length) {
        const errs: FieldErrors = {};
        for (const k of e.missing) {
          if (!FIELD_KEYS.includes(k as Field)) continue;
          errs[k as Field] = details[k as Field].trim() ? "Please check this." : "This is needed to book.";
        }
        setErrors(errs);
        setFormError(Object.keys(errs).length ? "Please check the highlighted fields." : errorText(e));
      } else {
        setFormError(errorText(e));
      }
      if (cal.turnstile_site_key) setTsReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  }

  const title = { service: "Choose a service", time: "Pick a date & time", info: "Your details", done: "" }[step];

  return (
    <div className="page" data-style={cal.branding.style}>
      <div className="sheet">
        <Header branding={cal.branding} onBack={step !== firstStep && step !== "done" ? () => history.back() : undefined}>
          {step !== "done" && <Steps labels={labels} current={stepIndex} />}
          {title && <h1 className="title">{title}</h1>}
          {step === "time" && service && (
            <p className="band-chips">
              <span className="band-chip">{service.name}</span>
              <span className="band-chip">{formatDuration(service.duration_min)}</span>
            </p>
          )}
        </Header>

        <main className="content" key={step}>

          {step === "service" && (
            <ServiceList
              services={cal.services}
              selectedId={serviceId}
              onSelect={(id) => {
                if (id !== serviceId) {
                  setDate(null);
                  setSlot(null);
                }
                setServiceId(id);
              }}
            />
          )}
          {step === "service" && !cal.services.length && <p className="muted">No services are open for booking right now.</p>}

          {step === "time" && service && (
            <>
              <div aria-live="assertive">
                {notice && (
                  <p className="alert" role="alert">
                    {notice}
                  </p>
                )}
              </div>
              <DateTimePicker
                source={{ kind: "slug", slug: cal.slug, serviceId: service.id }}
                businessZone={cal.time_zone}
                maxDaysAhead={cal.booking.max_days_ahead}
                zone={zone}
                onZone={setZone}
                date={date}
                slot={slot}
                onDate={(d) => {
                  setDate(d);
                  setSlot(null);
                }}
                onSlot={(s) => {
                  setSlot(s);
                  setNotice(null);
                }}
                reloadKey={reloadKey}
              />
            </>
          )}

          {step === "info" && service && slot && (
            <>
              <Summary
                rows={[
                  { icon: "service", label: "Service", value: `${service.name} · ${formatDuration(service.duration_min)}` },
                  { icon: "date", label: "Date", value: formatDate(slot, zone) },
                  { icon: "time", label: "Time", value: `${formatTime(slot, zone)} · ${zoneLabel(zone)}` },
                ]}
              />
              <form
                id="details"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void book();
                }}
              >
                <DetailsForm value={details} onChange={setDetails} required={required} errors={errors} consentWording={cal.consent_wording} />
                {cal.turnstile_site_key && <Turnstile siteKey={cal.turnstile_site_key} onToken={setToken} resetKey={tsReset} />}
              </form>
              <div aria-live="assertive">
                {formError && (
                  <p className="alert" role="alert">
                    {formError}
                  </p>
                )}
              </div>
            </>
          )}

          {step === "done" && booked && <Confirmed booked={booked} businessName={cal.branding.business_name} zone={zone} emailed={cal.emails.booked} />}
        </main>

        <PoweredBy show={cal.booking.powered_by} />
      </div>

      {step === "service" && (
        <ActionBar>
          <button type="button" className="btn btn-primary" disabled={!service} onClick={() => go("time")}>
            Continue
          </button>
        </ActionBar>
      )}
      {step === "time" && (
        <ActionBar
          note={
            slot ? (
              <>
                <span className="muted">{shortDate(slot, zone)}</span>{" "}
                <strong>{formatTime(slot, zone)}</strong>
              </>
            ) : (
              <span className="muted">Pick a time</span>
            )
          }
        >
          <button type="button" className="btn btn-primary" disabled={!slot} onClick={() => go("info")}>
            Continue
          </button>
        </ActionBar>
      )}
      {step === "info" && (
        <ActionBar>
          <button type="submit" form="details" className="btn btn-primary" disabled={!canBook}>
            {submitting ? "Booking…" : "Book appointment"}
          </button>
        </ActionBar>
      )}
    </div>
  );
}

export function LoadingScreen() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading">
      <div className="sheet">
        <div className="band band-skeleton" />
        <main className="content">
          <span className="skeleton line-lg" />
          <span className="skeleton block" />
          <span className="skeleton block" />
        </main>
      </div>
    </div>
  );
}

export function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="page">
      <main className="sheet content">
        <h1 className="title">We couldn't load this page</h1>
        <p className="muted" role="alert">
          {message}
        </p>
        <button type="button" className="btn btn-secondary" onClick={() => location.reload()}>
          Try again
        </button>
      </main>
    </div>
  );
}
