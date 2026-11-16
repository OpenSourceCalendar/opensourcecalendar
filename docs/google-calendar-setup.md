# Setting up Google Calendar sync

Google Calendar sync does two things:
- **Bookings go into the owner's Google Calendar.**
- **The owner's own busy Google events block those times on the booking page.**

To turn it on, the person who runs the booking calendar makes a free Google Cloud "OAuth client" once. It takes about 10 minutes. After that, each business owner connects their own Google Calendar from **Owner screens → Google Calendar → Connect Google Calendar**.

Google changes its menus from time to time, so the names below may be slightly different from what you see.

## 1. Create a Google Cloud project
1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and sign in.
2. Click the project picker at the top → **New project**. Name it something like "Booking Calendar" → **Create**.
3. Make sure the new project is selected in the picker.

## 2. Turn on the Google Calendar API
Search the top bar for **Google Calendar API**, open it, and click **Enable**.

## 3. Set up the sign-in screen
Menu → **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform**).
- **App name:** "Booking Calendar" (people see this when they connect).
- **Support email** and **contact email:** your email.
- **Audience:** **External**.
- You can skip the "Scopes" / "Data access" page. The booking calendar asks for what it needs when someone connects:
  - their email address;
  - permission to see and edit calendar events;
  - permission to see their list of calendars.

## 4. Publish the app (important)
Go to **Audience** and click **Publish app**, so the status says **In production**.

- **If you leave it in "Testing", Google disconnects every calendar after 7 days.**
- You don't need Google's review to use it yourself.
- When someone connects, Google shows a screen saying **"Google hasn't verified this app"**. Click **Advanced → Go to Booking Calendar (unsafe)** to continue. That's expected for an app you run yourself.
- Unverified apps can be connected by up to 100 Google accounts.
- If you'll offer this to other businesses, apply for Google's verification (Audience → "Prepare for verification"). That needs a home page, a privacy policy and a short video of the sign-in.

## 5. Create the OAuth client
Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**).
- **Application type:** Web application.
- **Name:** anything, e.g. "Booking Calendar".
- **Authorized redirect URIs:** add your booking calendar's address followed by `/api/google/callback`, for example:
  ```
  https://book.example.com/api/google/callback
  ```
  Use your `PUBLIC_URL` if you've set one, otherwise the worker's address. It must match exactly: `https`, no slash at the end.
- Click **Create**. Google shows a **Client ID** and a **Client secret**. Keep that window open.

## 6. Give the secrets to the booking calendar
From the project folder (add `--env <name>` for a named environment such as staging):
```
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32 | npx wrangler secret put GOOGLE_TOKEN_KEY
```
- Paste each value when asked.
- `GOOGLE_TOKEN_KEY` encrypts the Google sign-ins the booking calendar stores. Keep it; changing it later disconnects every calendar.
- Then deploy, and run the database migrations if you haven't yet.

## 7. Connect
Open the owner screens → **Google Calendar** → **Connect Google Calendar**.
1. Google opens in a new tab. Sign in, click past the "unverified" screen, and **tick every box**.
2. On the booking calendar's page, click **Connect**.

Bookings start appearing in Google within a minute.

## Troubleshooting
- **`redirect_uri_mismatch`**: the redirect URI in step 5 doesn't exactly match the address you're using. Check `https`, the domain, and that there's no slash at the end.
- **"Access blocked" or "app not available"**: the app is still in Testing and you aren't listed as a test user. Publish it (step 4).
- **Disconnected after about a week**: the app is still in Testing. Publish it, then click **Reconnect**.
- **"A permission box wasn't ticked"**: connect again and tick every box on Google's screen.
- **Owner screens inside another site (an iframe)**: Connect opens Google in a new tab. If the iframe has a `sandbox` attribute, it needs `allow-popups allow-popups-to-escape-sandbox`.
