import { useEffect, useRef } from "react";
import { icsUrl, type Booked } from "../api";
import { formatDate, formatDuration, formatTime, googleCalendarUrl, minutesBetween, zoneLabel } from "../time";
import { Summary } from "./Summary";

export function Confirmed({ booked, businessName, zone, emailed }: { booked: Booked; businessName: string; zone: string; /** A confirmation email is on its way. */ emailed: boolean }) {
  const a = booked.appointment;
  const manageUrl = new URL(booked.manage_path, window.location.origin).href;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const google = googleCalendarUrl({
    title: `${a.service_name}${businessName ? ` with ${businessName}` : ""}`,
    start: a.start,
    end: a.end,
    details: `Change or cancel: ${manageUrl}`,
  });

  return (
    <div className="confirmed" role="status" aria-live="polite">
      <div className="check" aria-hidden="true">
        <svg viewBox="0 0 52 52" width="56" height="56">
          <circle cx="26" cy="26" r="24" />
          <path d="M15 27l7 7 15-16" />
        </svg>
      </div>
      <h1 className="title center" tabIndex={-1} ref={heading}>
        You're booked!
      </h1>
      <p className="lede center">
        {a.contact.first_name ? `Thanks, ${a.contact.first_name}. ` : ""}We'll see you then.
      </p>
      {emailed && a.contact.email && (
        <p className="muted center small">
          We've emailed your confirmation to <strong>{a.contact.email}</strong>.
        </p>
      )}

      <Summary
        rows={[
          { icon: "date", label: "Date", value: formatDate(a.start, zone) },
          {
            icon: "time",
            label: "Time",
            value: (
              <>
                {formatTime(a.start, zone)} · {formatDuration(minutesBetween(a.start, a.end))}
                <span className="summary-sub">{zoneLabel(zone)}</span>
              </>
            ),
          },
          { icon: "service", label: "Service", value: a.service_name },
        ]}
      />

      <p className="sub">Add to your calendar</p>
      <div className="two">
        <a className="btn btn-secondary" href={google} target="_blank" rel="noopener noreferrer">
          Google
        </a>
        <a className="btn btn-secondary" href={icsUrl(booked.manage_token)} download="appointment.ics">
          Apple / Outlook
        </a>
      </div>

      <div className="changes">
        <p>Need to make changes?</p>
        <a href={booked.manage_path}>Reschedule or cancel</a>
      </div>
    </div>
  );
}
