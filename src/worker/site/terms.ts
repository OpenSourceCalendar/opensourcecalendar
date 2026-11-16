import { GITHUB_URL, page, SITE_NAME, SUPPORT_EMAIL } from "./layout";

export const TERMS_UPDATED = "November 16, 2026";
const TERMS_EMAIL = "terms@opensourcecalendar.com";

export function termsPage() {
  const band = `<div class="wrap doc-head"><h1>Terms of service</h1><p>Last updated ${TERMS_UPDATED}</p></div>`;
  const body = `<article class="wrap"><div class="doc">
<h2>About these terms</h2>
<p>These terms cover your use of ${SITE_NAME}: the website at opensourcecalendar.com, the booking pages it hosts, and the screens businesses use to manage them (together, “the service”). By using the service you agree to these terms. If you use it for a business, you agree for that business. “We” and “us” mean ${SITE_NAME}. Our <a href="/privacy">privacy policy</a> explains how we handle personal information.</p>

<h2>The software and the hosted service</h2>
<p>The ${SITE_NAME} software is open source under the <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License v3.0</a> (AGPL-3.0). If you run your own copy from <a href="${GITHUB_URL}">the source code</a>, that licence governs your use of the code, and these terms do not apply to your copy.</p>
<p>These terms apply to the service we run for you. Hosted plans are not on sale yet. Until they are, the service is offered as is, and features may change.</p>

<h2>Booking an appointment</h2>
<p>If you book through a booking page, your appointment is with that business, not with us. The business sets its services, prices, hours and policies, and is responsible for the appointment itself. Please give accurate details, and use the link in your email to change or cancel.</p>

<h2>Businesses using the service</h2>
<ul>
<li>Keep your sign-in details safe. You are responsible for what happens under your account.</li>
<li>Give accurate information on your booking page about your services, prices and policies.</li>
<li>You are responsible for your customers’ information: tell them how you use it, have a lawful reason to collect it, and answer their requests, including deletion requests.</li>
<li>Only send text messages to customers who have given permission, and follow the laws on calls, texts and email that apply to you.</li>
<li>Agencies that set up the service for clients are responsible for having their clients’ permission to do so.</li>
</ul>

<h2>Acceptable use</h2>
<p>Do not use the service to:</p>
<ul>
<li>break the law or anyone else’s rights;</li>
<li>send spam or messages people did not ask for;</li>
<li>offer illegal goods or services, or mislead customers;</li>
<li>upload harmful code, or try to get into accounts or data that are not yours;</li>
<li>overload, probe or disrupt the service, or get around its limits or bot checks.</li>
</ul>
<p>We may suspend or remove content or accounts that break these rules.</p>

<h2>Your content</h2>
<p>You keep ownership of what you put into the service: your business details, images and customer records. You give us permission to store and process it only as needed to run the service for you. You can delete it, or ask us for a copy, at any time. If we close your account we will give you a reasonable chance to export it first, unless the law or a serious breach of these terms prevents it.</p>

<h2>Plans and payments</h2>
<p>When hosted plans launch, prices will be shown on our home page and at checkout. Paid plans will renew automatically until cancelled, and you can cancel at any time; the plan stays active until the end of the period you paid for. Paid plans will start with a 14-day free trial that needs a card. If you cancel before the trial ends you won’t be charged and your account moves to the Free plan; otherwise the paid plan starts when the trial ends. The Free plan needs no card. We will give notice before changing the price of a plan you are on.</p>

<h2>Third-party services</h2>
<p>The service relies on others, including Cloudflare for hosting and email, and Google if you connect Google Calendar. Their own terms also apply to your use of them, and we are not responsible for their services.</p>

<h2>Availability and changes</h2>
<p>We work to keep the service running and your data safe, but we can’t promise it will always be available or free of errors. Emails can be delayed or caught by spam filters. We may change or stop parts of the service; if we stop the hosted service entirely, we will give reasonable notice so you can export your data or move to your own copy.</p>

<h2>Disclaimer</h2>
<p>The service is provided “as is” and “as available”. As far as the law allows, we make no promises beyond those in these terms, including any implied promises of fitness for a particular purpose or that the service will meet your needs.</p>

<h2>Limit of liability</h2>
<p>As far as the law allows, we are not liable for indirect or consequential losses, such as lost profits, lost bookings or lost data. Our total liability for any claim about the service is limited to the greater of the amount you paid us in the 12 months before the claim, or US $100. Some places don’t allow these limits, so they may not all apply to you.</p>

<h2>Indemnity</h2>
<p>If you use the service for a business and a claim is made against us because of your content, your dealings with your customers, or your breach of these terms or the law, you agree to cover our reasonable costs of that claim.</p>

<h2>Ending use</h2>
<p>You can stop using the service at any time. We may suspend or end access if you seriously or repeatedly break these terms, or if we must for legal or security reasons.</p>

<h2>Law and disputes</h2>
<p>These terms are governed by the laws of the State of Oregon, USA, without regard to its conflict-of-laws rules. Disputes will be heard in the state or federal courts located in Oregon, unless the law where you live gives you the right to bring them elsewhere. Please contact us first; most problems can be sorted out quickly.</p>

<h2>Changes to these terms</h2>
<p>We may update these terms. We will change the date at the top, and tell businesses using the service about important changes before they take effect. Using the service after that means you accept the new terms.</p>

<h2>Contact</h2>
<p>Questions about these terms: <a href="mailto:${TERMS_EMAIL}">${TERMS_EMAIL}</a>. Help with the service: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
</div></article>`;
  return page({
    title: `Terms of service | ${SITE_NAME}`,
    description: `The terms for using ${SITE_NAME}'s hosted booking calendar.`,
    path: "/terms",
    band,
    body,
  });
}
