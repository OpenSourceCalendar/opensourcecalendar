import { page, PRIVACY_EMAIL, SITE_NAME } from "./layout";

export const PRIVACY_UPDATED = "November 16, 2026";

// Keep this in step with what the code really stores. Checked against migrations 0001–0009,
// routes/customers.ts (deletion), google/push.ts (event contents), google/busy.ts and email/outbox.ts (30-day job cleanup).
export function privacyPage() {
  const band = `<div class="wrap doc-head"><h1>Privacy policy</h1><p>Last updated ${PRIVACY_UPDATED}</p></div>`;
  const body = `<article class="wrap"><div class="doc">
<h2>Who we are</h2>
<p>${SITE_NAME} is an online booking calendar for businesses, available at opensourcecalendar.com and its booking addresses. This policy explains what information the service handles, why, and the choices you have. Questions go to <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>.</p>
<p>${SITE_NAME} is also open-source software. If a business runs its own copy on its own servers, that business is responsible for it and this policy does not cover it.</p>

<h2>Two kinds of people use the service</h2>
<ul>
<li><strong>Businesses</strong> that set up a booking page (and the agencies that set them up for clients).</li>
<li><strong>Customers</strong> who book an appointment with one of those businesses.</li>
</ul>
<p>When you book with a business, that business decides what it asks for and what it does with your booking. We store and process your booking for the business, on its behalf. For questions about a particular business’s use of your details, contact that business; we will also help if you write to us.</p>

<h2>Information we handle</h2>
<h3>When you book an appointment</h3>
<ul>
<li>Your first and last name, and the email address and phone number you enter.</li>
<li>Any note you add, and the service, date and time you choose.</li>
<li>If you tick the box to receive text messages, a record of that permission: the wording you agreed to, the phone number and the time.</li>
<li>The time zone your device uses, so times are shown correctly.</li>
</ul>
<p>Each booking keeps a copy of the contact details entered for it, so the business can see who booked even if details change later.</p>

<h3>When a business uses the service</h3>
<ul>
<li>The business name, booking-page settings, services, prices, opening hours and days off.</li>
<li>Logos and photos the business uploads.</li>
<li>Customer and appointment records the business adds or edits.</li>
<li>If the business connects Google Calendar: the Google account’s email address, the name and ID of the chosen calendar, and the sign-in tokens Google gives us (stored encrypted). See “Google Calendar” below.</li>
</ul>

<h3>When you join the waitlist</h3>
<p>Your email address and the date you joined. Nothing else.</p>

<h3>Technical information</h3>
<p>To keep the service working and safe, our hosting provider Cloudflare processes your IP address and basic browser details when you load a page, and keeps short-lived technical logs. The booking page uses Cloudflare Turnstile to check that a booking comes from a person, not a bot; Turnstile works without advertising cookies.</p>

<h2>How we use it</h2>
<ul>
<li>To show booking pages, take bookings and stop two people booking the same time.</li>
<li>To send booking emails: confirmations, changes, cancellations and reminders, to the customer and to the business.</li>
<li>To let customers change or cancel their own booking from the private link in their email.</li>
<li>To copy bookings into the business’s Google Calendar and block times it is busy, when the business turns that on.</li>
<li>To send one email to waitlist members when hosted plans open.</li>
<li>To keep the service secure, prevent abuse and fix problems.</li>
</ul>
<p>We do not sell personal information, share it for advertising, or use it to build marketing profiles. We do not send marketing emails to a business’s customers.</p>

<h2>Google Calendar</h2>
<p>A business can connect its Google Calendar. When it does, Google asks the business to allow two things:</p>
<ul>
<li><strong>See the list of its calendars</strong>, so it can choose which one to use.</li>
<li><strong>See and edit events on the chosen calendar.</strong> We read when events start and end, and whether they are marked busy, so those times can’t be booked. We store only those start and end times, not event titles, descriptions or guests. We also add, update and remove events for appointments made through the booking calendar; these events include the service, and the customer’s name, phone, email and note, so the business can see them in its own calendar.</li>
</ul>
<p>${SITE_NAME}’s use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. In particular, we use Google data only to provide the calendar features the business turned on; we do not use it for advertising, do not sell it, do not use it to train AI or machine-learning models, and no person reads it except with the business’s permission, for security, or where the law requires.</p>
<p>A business can disconnect Google at any time from its settings. That deletes the stored tokens and busy times right away. Access can also be removed from the Google account at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>

<h2>Who else handles the information</h2>
<ul>
<li><strong>Cloudflare</strong> hosts the service, stores its data, sends its emails and runs the Turnstile bot check.</li>
<li><strong>Google</strong>, only when a business connects Google Calendar, as described above.</li>
<li><strong>The business you booked with</strong>, which can see and manage your booking. A business can also connect its own software (for example a customer database) to receive booking details.</li>
</ul>
<p>We may also disclose information if the law requires it, or to protect people or the service from harm or fraud.</p>

<h2>How long we keep it</h2>
<ul>
<li>Bookings and customer details stay until the business deletes them, or until a deletion request is handled.</li>
<li>Records of sent emails and other background tasks are deleted after 30 days.</li>
<li>Google tokens and busy times are deleted when the business disconnects Google.</li>
<li>Waitlist addresses are kept until hosted plans open and we have sent the one email, or until you ask us to remove yours.</li>
<li>Text-message permission records are kept after a deletion as proof that permission was given.</li>
</ul>

<h2>Your choices and rights</h2>
<ul>
<li><strong>Customers</strong> can ask for their details to be deleted from the manage link in any booking email. The business sees the request and deletes the details; this also removes them from bookings copied to Google Calendar. You can also write to us.</li>
<li><strong>Anyone</strong> can ask us for a copy of the information we hold about them, or ask us to correct or delete it, by emailing <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>. We may need to check it’s really you, and we may pass a request to the business it concerns.</li>
<li>Depending on where you live, you may have more rights under laws such as the GDPR or US state privacy laws. We will honor them.</li>
</ul>

<h2>Cookies and tracking</h2>
<p>We do not use advertising or analytics cookies, and we do not track you across other websites. The owner screens keep a sign-in key in your browser for the current tab, and remember small display choices such as the calendar view.</p>

<h2>Security</h2>
<p>All traffic is encrypted. Google sign-in tokens are encrypted before they are stored. Customers’ manage links are signed so they can’t be guessed. No system is perfectly secure, but we work to protect your information and will tell affected people about a breach as the law requires.</p>

<h2>Children</h2>
<p>The service is meant for businesses and adults booking appointments. It is not directed at children under 13, and we do not knowingly collect their information.</p>

<h2>Where the data is</h2>
<p>Data is stored and processed by Cloudflare, which may handle it in the United States and other countries.</p>

<h2>Changes</h2>
<p>If we change this policy, we will update the date at the top. For important changes we will also tell businesses using the service.</p>

<h2>Contact</h2>
<p>Email <a href="mailto:${PRIVACY_EMAIL}">${PRIVACY_EMAIL}</a>.</p>
</div></article>`;
  return page({
    title: `Privacy policy | ${SITE_NAME}`,
    description: `How ${SITE_NAME} handles booking details, Google Calendar data and waitlist emails.`,
    path: "/privacy",
    band,
    body,
  });
}
