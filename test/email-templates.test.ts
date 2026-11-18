import { describe, it, expect } from "vitest";
import { customerEmail, ownerEmail, type EmailFacts } from "../src/worker/email/templates";

const base: EmailFacts = {
  businessName: "Demo Plumbing",
  businessPhone: "(503) 555-0100",
  brandColor: "#1d4ed8",
  serviceName: "Drain cleaning",
  start: Date.parse("2026-11-17T23:00:00Z"), // 6:00 PM in New York, 3:00 PM in Los Angeles
  end: Date.parse("2026-11-18T00:00:00Z"),
  timeZone: "America/New_York",
  manageUrl: "https://cal.example/m/tok",
  bookUrl: "https://cal.example/book/demo",
  scheduleUrl: "https://cal.example/admin/schedule",
  locationText: "At your place",
  confirmationMessage: "Thanks for booking with [Business Name]. See you [Date] at [Time] for [Service].",
  poweredBy: true,
  cancelReason: "Running late",
  customer: { name: "Pat Lee", phone: "503-555-0140", email: "pat@example.com" },
  note: "Back gate",
};

describe("customer emails", () => {
  it("confirmation: in the customer's time zone, with the link and the filled-in message", () => {
    const e = customerEmail("booked", base);
    expect(e.subject).toBe("Your appointment with Demo Plumbing is confirmed");
    for (const part of ["Tuesday, November 17", "6:00 PM", "Eastern", "Drain cleaning", "https://cal.example/m/tok", "(503) 555-0100"]) {
      expect(e.text).toContain(part);
      expect(e.html).toContain(part);
    }
    expect(e.text).toContain("Thanks for booking with Demo Plumbing. See you Tuesday, November 17 at 6:00 PM for Drain cleaning.");
    expect(e.html).toContain("#1d4ed8");
    expect(e.text).toContain("using Open Source Calendar");
  });

  it("never shows what was typed, or the cancel reason", () => {
    for (const kind of ["booked", "changed", "cancelled", "reminder"] as const) {
      const e = customerEmail(kind, base);
      for (const typed of ["Pat", "Back gate", "Running late", "pat@example.com"]) expect(e.text + e.html).not.toContain(typed);
    }
  });

  it("change, cancellation and reminder wording", () => {
    expect(customerEmail("changed", base).subject).toBe("Your appointment with Demo Plumbing has changed");
    const cancelled = customerEmail("cancelled", { ...base, manageUrl: null });
    expect(cancelled.subject).toBe("Your appointment with Demo Plumbing is cancelled");
    expect(cancelled.text).not.toContain("/m/");
    expect(cancelled.text).toContain("https://cal.example/book/demo");
    expect(customerEmail("reminder", base).subject).toBe("Reminder: Drain cleaning on Tuesday, November 17 at 6:00 PM");
  });

  it("a business with no name, and no 'Powered by'", () => {
    const e = customerEmail("booked", { ...base, businessName: "", poweredBy: false });
    expect(e.subject).toBe("Your appointment is confirmed");
    expect(e.text).not.toContain("undefined");
    expect(e.text).not.toContain("using Open Source Calendar");
  });
});

describe("owner emails", () => {
  it("in the business's time zone, with the customer's details and the schedule link", () => {
    const e = ownerEmail("new", { ...base, timeZone: "America/Los_Angeles" });
    expect(e.subject).toBe("New booking: Pat Lee, Tue, Nov 17, 3:00 PM");
    for (const part of ["Pat Lee", "503-555-0140", "pat@example.com", "Back gate", "https://cal.example/admin/schedule", "Pacific"]) expect(e.text).toContain(part);
    expect(ownerEmail("cancelled", base).text).toContain("Running late");
    expect(ownerEmail("new", base).text).not.toContain("Running late");
  });
  it("owner emails leave out the schedule link when there's no dashboard to open (a White-label client)", () => {
    const e = ownerEmail("new", { ...base, scheduleUrl: null });
    expect(e.text).not.toContain("Open your schedule");
    expect(e.text).not.toContain("sign in");
    expect(e.html).not.toContain("Open your schedule");
  });
});

describe("escaping", () => {
  const nasty: EmailFacts = {
    ...base,
    businessName: "<script>alert(1)</script> & Co",
    serviceName: "<b>x</b>",
    customer: { name: "<b>Bob</b>\r\nBcc: x@y.z", phone: null, email: null },
    note: "</td><img src=x onerror=1>",
  };
  it("escapes everything a person typed in HTML, and keeps subjects on one line", () => {
    const c = customerEmail("booked", nasty);
    expect(c.html).not.toContain("<script>");
    expect(c.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
    expect(c.html).not.toContain("<b>x</b>");
    expect(c.text).toContain("<b>x</b>"); // plain text is shown as typed
    const o = ownerEmail("new", nasty);
    expect(o.html).not.toContain("<img");
    expect(o.subject).not.toMatch(/[\r\n]/);
    expect(o.subject).toContain("Bcc: x@y.z"); // harmless once it's on the same line
  });

  it("fills in the message in one pass: a business named [Time] isn't filled in twice", () => {
    const e = customerEmail("booked", { ...nasty, businessName: "[Time]", confirmationMessage: "From [Business Name] at [Time] for [Service]" });
    expect(e.text).toContain("From [Time] at 6:00 PM for <b>x</b>");
    expect(e.html).toContain("From [Time] at 6:00 PM for &lt;b&gt;x&lt;/b&gt;");
  });
});
