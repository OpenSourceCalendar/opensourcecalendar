# Webhooks: booking events for your app

When a booking is made, changed or cancelled, or a customer is added or deleted, the calendar can `POST` a signed message to your app. Each app has **one** webhook address, set with its API key.

All requests below use your app's API key, plus any `X-Calendar-User` of yours (the routes need the header, but webhook settings belong to the whole app, not one calendar):
```
Authorization: Bearer <api key>
X-Calendar-User: <any of your users>
```

## Set it up
| Request | Does |
|---|---|
| `PUT /api/v1/webhook` `{ "url": "https://your.app/hooks/calendar" }` | Sets the address. The answer includes the **signing secret** `whsec_…`: save it. It's only shown here and by rotate-secret. |
| `GET /api/v1/webhook` | `{ "url": … }` (no secret) |
| `POST /api/v1/webhook/test` | Sends a `ping` now: `{ "delivered": true, "status": 200 }` |
| `GET /api/v1/webhook/deliveries` | The last 50 events: id, type, `created_at`, attempts, result, `next_try_at` |
| `POST /api/v1/webhook/rotate-secret` | A new secret. The old one stops working at once. (Setting an address again after `DELETE` also gives a new secret.) |
| `DELETE /api/v1/webhook` | Stops all events, including ones still waiting. |

The address must be `https://`, use a domain name rather than an IP address, have no username or password in it, and not point at the calendar itself.

## Events
| `type` | When | `data` |
|---|---|---|
| `booking.created` | A booking is made (by a customer, the owner or your app), or a cancelled one is reopened | `{ "appointment": … }` |
| `booking.changed` | Its time or service changes, or the customer deletes their data from a past or already-cancelled booking (its contact comes through erased) | `{ "appointment": … }` |
| `booking.cancelled` | It's cancelled, including when the customer deletes their data from an upcoming booking | `{ "appointment": … }` |
| `customer.created` | A new customer record is made (not when an existing one is matched) | `{ "customer": … }` |
| `customer.deleted` | The owner deletes a customer | `{ "customer": { "id", "external_ref" } }`: erase your copy of the customer **and** the contact details and notes on their appointments (no separate booking events are sent for those) |
| `ping` | You called `/webhook/test` | `{}` |

Status changes (confirmed, done, no-show) and note edits don't send events.

`appointment` and `customer` have the same shape as `GET /api/v1/appointments/:id` and `GET /api/v1/customers/:id`.

```json
{
  "id": "evt_…",
  "type": "booking.created",
  "created_at": "2026-11-16T17:00:03.000Z",
  "calendar": { "id": "cal_…", "external_user_id": "your-user-id", "slug": "demo" },
  "data": { "appointment": { "id": "apt_…", "status": "booked", "start": "…", "updated_at": "…" } }
}
```

**Treat the body as "how it is now".** It's built when it's sent, not when the event happened. Events can also arrive **out of order**: a retried `booking.created` can land after its `booking.cancelled`. Keep the version with the newest `data.appointment.updated_at`.

## Check the signature
Every request has `X-Calendar-Signature: t=<unix seconds>,v1=<hex>`. `v1` is HMAC-SHA256 of `<t>.<raw body>`, keyed with the whole `whsec_…` string (as UTF-8 bytes). Check it before trusting the body, and reject old timestamps:

```js
async function verify(request, secret) {
  const header = request.headers.get("X-Calendar-Signature") ?? "";
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const body = await request.text();
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return null; // older than 5 minutes
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(v1.match(/../g) ?? [], (h) => parseInt(h, 16));
  const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(`${t}.${body}`)); // constant-time
  return ok ? JSON.parse(body) : null;
}
```

## Answer quickly, expect retries
- Answer any **2xx** within 5 seconds; do slow work afterwards. Redirects aren't followed.
- Anything else, or no answer, is retried after 1, 5, 15, 60, 60 and 60 minutes: 7 tries, about 3½ hours. **410 Gone** stops retries for that event.
- The same event can arrive twice. Use `id` to ignore repeats.

## Good to know
- Your events come from your own calendars only.
- The signing secret is derived from the calendar server's `MANAGE_SECRET`. If that's ever changed, every app's webhook secret changes too: call `rotate-secret` (or `PUT` again) to get the new one.
