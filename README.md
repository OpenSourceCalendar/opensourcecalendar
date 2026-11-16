<p align="center">
  <img src="public/logo-512.png" width="96" height="96" alt="Open Source Calendar logo">
</p>

<h1 align="center">Open Source Calendar</h1>

<p align="center">
  <strong>Free, open-source appointment booking software you can host yourself.</strong><br>
  Customers book, reschedule and cancel online. You get email reminders, two-way Google Calendar sync and no double bookings.<br>
  A self-hosted alternative to Calendly, Acuity and Easy!Appointments, running on Cloudflare Workers.
</p>

<p align="center">
  <a href="https://opensourcecalendar.com">Website</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="docs/google-calendar-setup.md">Google Calendar setup</a> ·
  <a href="docs/webhooks.md">Webhooks</a>
</p>

---

## What it is

Open Source Calendar is an **online booking system** for any business that takes appointments: plumbers, salons, clinics, tutors, consultants, and the agencies that run their websites. Each business gets a booking page where customers pick a service and a time. The owner manages the schedule, services, hours and customers from a simple dashboard.

It runs entirely on **Cloudflare** (Workers, D1, R2 and Email Sending), so there is no server to maintain, and a small business can usually run it within Cloudflare's free tier.

Don't want to host it yourself? Hosted plans are coming at **[opensourcecalendar.com](https://opensourcecalendar.com)**.

## Features

- **Online booking page** that works well on phones, with your logo, colors and a choice of page styles.
- **No double bookings.** Every booking is checked against open times when it is saved.
- **Self-service changes.** Each confirmation email has a private link to reschedule or cancel.
- **Email confirmations and reminders** with a calendar (.ics) file, shown in the customer's own time zone.
- **Two-way Google Calendar sync.** Bookings appear in the owner's Google Calendar, and busy Google events block those times.
- **Services, hours, breaks, days off and time blocks**, with buffers and booking-window rules.
- **Customer records** with notes, text-message consent records and "delete my data" requests.
- **Share anywhere:** a link, a QR code, or embedded on your own website.
- **Built for developers:** a REST API, API keys per app and signed webhooks, so it can power the booking feature in your own product.
- **Bot protection** with Cloudflare Turnstile and limits that stop the booking form being used to spam people.

## Quick start

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/OpenSourceCalendar/opensourcecalendar.git
cd opensourcecalendar
npm install
npx wrangler login
```

1. **Create the database and the image store:**
   ```bash
   npx wrangler d1 create booking-calendar
   npx wrangler r2 bucket create booking-calendar-images
   ```
   Copy the `database_id` that the first command prints into `wrangler.toml`.
2. **Create the tables:** `npm run migrate:prod`
3. **Set three secrets.** Each command asks you to type a value. Use a long random string for the first two, for example from `openssl rand -base64 32`:
   ```bash
   npx wrangler secret put MANAGE_SECRET    # signs customers' manage links
   npx wrangler secret put SESSION_SECRET   # signs owner sign-ins
   npx wrangler secret put OWNER_PASSWORD   # the password you sign in with
   ```
4. **Deploy:** `npm run deploy`
5. Open `https://<your-worker>.workers.dev/admin`, sign in with your password, and follow **Set up your calendar**. Your booking page is then at `/book/<your-name>`.

### Optional extras

- **Emails:** add your domain to [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/), then set the `EMAIL_FROM` secret (for example `bookings@yourdomain.com`). Turn on Turnstile at the same time (`TURNSTILE_SITE_KEY` in `wrangler.toml` and the `TURNSTILE_SECRET` secret).
- **Your own domain:** add a `routes` entry with `custom_domain = true` in `wrangler.toml`, and set `PUBLIC_URL` to it.
- **Google Calendar sync:** follow [docs/google-calendar-setup.md](docs/google-calendar-setup.md) (about 10 minutes).
- **Use it inside your own app:** create an API key with the `SETUP_TOKEN` secret, then see [docs/webhooks.md](docs/webhooks.md) and the routes in `src/worker/routes/`.

Every setting is described in the comments in `wrangler.toml`.

## Tech stack

| Part | Built with |
|---|---|
| Server | Cloudflare Workers, [Hono](https://hono.dev/), TypeScript |
| Database | Cloudflare D1 (SQLite), plain SQL migrations in `migrations/` |
| Images | Cloudflare R2 |
| Email | Cloudflare Email Sending |
| Booking page and owner dashboard | React and Vite |
| Tests | Vitest running inside workerd (`npm test`) |

## Development

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply booking-calendar --local
npm run dev        # http://localhost:5173
npm run seed       # in a second terminal: creates a demo calendar
npm test
npm run typecheck
```

## Contributing

Issues and pull requests are welcome. Please add a test for any change to booking rules, and run `npm test` and `npm run typecheck` before opening a pull request.

## License

[GNU AGPL-3.0](LICENSE). You can use, change and host it for free. If you run a changed version as a service for others, you must share your changes under the same license.
