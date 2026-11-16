import { GITHUB_URL, page, SITE_NAME } from "./layout";

const GITHUB_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>`;
const TICK = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#0f766e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const FEATURES: [string, string][] = [
  ["No double bookings", "Two people can never take the same time. Every booking is checked the moment it is saved."],
  ["Two-way Google Calendar", "Your Google events block those times, and new bookings appear in your Google Calendar."],
  ["Reminders that arrive", "Confirmation and reminder emails with a calendar file, shown in your customer’s own time zone."],
  ["Customers change it themselves", "Every email has a link to reschedule or cancel. No phone tag."],
  ["Your brand, your look", "Your logo and color, with a choice of page styles that match the buttons."],
  ["On your website", "Share a link or QR code, or put the booking page right on your own site."],
  ["Privacy built in", "Customers can ask for their details to be deleted from their booking link."],
  ["For developers", "A full API and signed webhooks to connect your own apps."],
  ["Text reminders", "Coming soon as an add-on, on registered business numbers."],
];

const STEPS: [string, string][] = [
  ["Add your services and hours", "What people can book, how long it takes, and when you work."],
  ["Share your link", "Send it, print the QR code, or embed it on your website."],
  ["Get booked", "Customers pick a time; you and they get the emails, and it lands in your calendar."],
];

type Plan = { name: string; price: string; per: string; yearly: string; now: boolean; items: string[]; cta: string; href: string; hi: boolean };
const PLANS: Plan[] = [
  { name: "Self-hosted", price: "$0", per: "forever", yearly: "On your own Cloudflare account", now: true, items: ["Every feature", "Unlimited calendars", "Your servers, your data"], cta: "Get it on GitHub", href: GITHUB_URL, hi: false },
  { name: "Free", price: "$0", per: "hosted", yearly: "", now: false, items: ["1 calendar", "No card needed", "All page styles", "Email confirmations", "“Powered by” footer"], cta: "Join the waitlist", href: "#waitlist", hi: false },
  { name: "Pro", price: "$10", per: "/ month", yearly: "or $100 a year", now: false, items: ["Unlimited staff calendars", "Google Calendar sync", "Reminder emails", "No footer"], cta: "Join the waitlist", href: "#waitlist", hi: true },
  { name: "White-label", price: "$50", per: "/ month", yearly: "or $500 a year", now: false, items: ["Unlimited client businesses", "Your brand only", "An address per client", "One login for all clients"], cta: "Join the waitlist", href: "#waitlist", hi: false },
];

const AGENCY = [
  "Unlimited client businesses for one price",
  "Your logo and colors; no mention of us",
  "A booking address for every client, or their own domain",
  "We can design custom pages for your clients",
];

const FAQ: [string, string][] = [
  ["Is it really free?", "Yes. The code is open source and free to run on your own Cloudflare account. You only pay if you want us to host it."],
  ["How does the free trial work?", "Pro and White-label start with 14 days free. You add a card to begin, and you won’t be charged if you cancel before the trial ends; your account then moves to the Free plan and keeps its bookings. The Free plan itself needs no card."],
  ["Does it work with Google Calendar?", "Yes. Your Google events block times on your booking page, and bookings are added to your Google Calendar."],
  ["Can I put it on my own website?", "Yes. Share the link, print the QR code, or paste the embed code into your site."],
  ["Can my agency resell it?", "Yes. The White-label plan removes our name and lets you run unlimited client businesses under your brand."],
];

const GALLERY: { title: string; phone: boolean; shots: [string, string, string][] }[] = [
  { title: "What your customers see", phone: true, shots: [
    ["customer-service", "Pick a service", "Step 1 of booking: a list of services with their length and price"],
    ["customer-details", "Add their details", "The last booking step: name and phone, with the chosen time shown above"],
    ["customer-confirmed", "Booked", "The confirmation screen, with buttons to add the visit to Google or Apple calendar"],
    ["customer-manage", "Change or cancel", "The customer’s own page to pick a new time or cancel"],
  ] },
  { title: "What you see", phone: false, shots: [
    ["owner-services", "Services", "The services list: each service with its length and price"],
    ["owner-customers", "Customers", "The customer list, searchable by name, phone or email"],
    ["owner-branding", "Branding", "Branding settings with a live preview of the booking page"],
    ["owner-share", "Share & promote", "Your booking link, a website button and embed code"],
  ] },
];

export type WaitlistState = "joined" | "bad" | null;

const WAIT_MSG: Record<Exclude<WaitlistState, null>, string> = {
  joined: "You’re on the list. We’ll send one email when hosting opens.",
  bad: "That email address doesn’t look right. Please check it and try again.",
};

export function homePage(wait: WaitlistState) {
  const band = `<div class="wrap hero">
<div class="hero-text">
<span class="pill">Open source · AGPL-3.0 · Runs on Cloudflare</span>
<h1>The booking app you can own for free.</h1>
<p class="lead">Let customers book, change and cancel on their own. Free to host yourself, or we’ll host it for you for $10 a month with unlimited staff calendars.</p>
<div class="actions"><a class="btn btn-light" href="${GITHUB_URL}">${GITHUB_ICON}Get it free on GitHub</a><a class="btn btn-ghost" href="#waitlist">Join the hosted waitlist</a></div>
<span class="small">Hosted plans launch soon. The Free plan needs no card; paid plans start with a 14-day free trial.</span>
</div>
<div class="phone"><img src="/screenshots/booking-phone.png" width="780" height="2106" alt="A booking page on a phone: the customer has picked drain cleaning on Wednesday, November 18 at 10:30 AM"></div>
</div>`;

  const features = FEATURES.map(([t, p], i) => `<div class="card"><span class="num">${String(i + 1).padStart(2, "0")}</span><h3>${t}</h3><p>${p}</p></div>`).join("");
  const steps = STEPS.map(([t, p], i) => `<li><b>${i + 1}</b><span><strong>${t}</strong>${p}</span></li>`).join("");
  const plans = PLANS.map((p) => `<div class="plan${p.hi ? " hi" : ""}">
<div class="plan-head"><h3>${p.name}</h3><span class="badge${p.now ? " now" : ""}">${p.now ? "Available now" : "Coming soon"}</span></div>
<div class="price"><b>${p.price}</b><span>${p.per}</span></div>
<span class="per-year">${p.yearly}</span>
<ul class="ticks">${p.items.map((i) => `<li>${TICK}${i}</li>`).join("")}</ul>
<a class="btn ${p.hi ? "btn-brand" : "btn-plain"}" href="${p.href}">${p.cta}</a>
</div>`).join("");
  const faq = FAQ.map(([q, a]) => `<div class="card"><h3>${q}</h3><p>${a}</p></div>`).join("");
  const gallery = GALLERY.map((g) => `<h3 class="gal-title">${g.title}</h3>
<div class="gallery${g.phone ? " phones" : ""}">${g.shots.map(([file, cap, alt]) => `<a href="/screenshots/${file}.png"><img src="/screenshots/${file}.png" width="${g.phone ? 780 : 2880}" height="${g.phone ? 1688 : 1800}" loading="lazy" alt="${alt}"><span>${cap}</span></a>`).join("")}</div>`).join("\n");
  const msg = wait ? `<p class="msg" role="status">${WAIT_MSG[wait]}</p>` : "";

  const body = `<div class="sections">
<section aria-labelledby="h-shots" class="wrap">
<div class="intro"><h2 id="h-shots">Your whole week in one place</h2><p>See every booking at a glance, and what’s next today. These are real screens from a demo business.</p></div>
<div class="shots">
<figure><img src="/screenshots/schedule.png" width="2880" height="1800" loading="lazy" alt="The owner’s week schedule, with a dozen appointments laid out by day and time"><figcaption>The schedule: month, week or day.</figcaption></figure>
<figure><img src="/screenshots/dashboard.png" width="2880" height="1800" loading="lazy" alt="The owner’s dashboard: today’s appointments, this week’s totals and recent customers"><figcaption>The dashboard: today at a glance.</figcaption></figure>
</div>
${gallery}
</section>

<section id="features" aria-labelledby="h-features" class="wrap">
<div class="intro"><h2 id="h-features">Everything you need to take bookings</h2><p>For any business that takes appointments, from one person to a whole team.</p></div>
<div class="grid">${features}</div>
</section>

<section aria-labelledby="h-how" class="wrap">
<h2 id="h-how">Up and running in an afternoon</h2>
<ol class="steps">${steps}</ol>
</section>

<section id="pricing" aria-labelledby="h-pricing" class="wrap">
<div class="intro"><h2 id="h-pricing">Simple prices. Unlimited staff on every paid plan.</h2><p>Hosted plans are coming soon. Pay yearly and get two months free.</p></div>
<div class="plans">${plans}</div>
<p class="note">Add-ons: custom design $100 one-time · your own domain $50 setup · text reminders $50 setup + $20/month.</p>
</section>

<section id="agencies" aria-labelledby="h-agencies" class="dark">
<div class="wrap split">
<div><span class="pill">White-label · $50/month</span><h2 id="h-agencies">Businesses: sell it as your own</h2><p>Give every client a booking calendar under your brand. No per-client fees, no “powered by”, one place to manage them all.</p></div>
<ul class="dots">${AGENCY.map((a) => `<li>${a}</li>`).join("")}</ul>
</div>
</section>

<section aria-labelledby="h-open" class="wrap split">
<div><h2 id="h-open">Open source, for real</h2><p class="muted">Every line of code is public under the AGPL-3.0 licence. Run it on your own Cloudflare account for free, read how it works, or pay us to run it for you. Your data is never locked in.</p></div>
<div class="code" aria-label="Three commands to deploy it"><div><i>$</i> git clone ${GITHUB_URL}</div><div><i>$</i> npm install</div><div><i>$</i> npm run deploy</div><div><em>✓ Your booking calendar is live</em></div></div>
</section>

<section aria-labelledby="h-faq" class="wrap faq">
<h2 id="h-faq">Questions</h2>
${faq}
</section>

<section id="waitlist" aria-labelledby="h-wait" class="band wait">
<div class="wrap">
<h2 id="h-wait">Be first when hosting opens</h2>
<p>One email when it’s ready. Nothing else.</p>
${msg}
<form method="post" action="/api/waitlist">
<label for="wl-email" class="sr">Email address</label>
<input id="wl-email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@business.com">
<label class="hp" aria-hidden="true">Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label>
<button class="btn btn-dark" type="submit">Join the waitlist</button>
</form>
<p class="small">We only use it to tell you hosting is open. See our <a href="/privacy" style="color:#fff">privacy policy</a>.</p>
</div>
</section>
</div>`;

  return page({
    title: `${SITE_NAME}: free, open-source online booking for any business`,
    description: "An open-source booking calendar for any business that takes appointments. Customers book, change and cancel on their own. Free to self-host on Cloudflare, or hosted from $10 a month.",
    path: "/",
    band,
    body,
  });
}
