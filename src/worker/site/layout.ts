// The public website (home, privacy, terms): plain HTML sent by the worker, so search engines and
// Google's app review read it without running the React app. No cookies, no trackers, no outside fonts.

export const SITE_NAME = "Open Source Calendar";
export const GITHUB_URL = "https://github.com/OpenSourceCalendar/opensourcecalendar";
export const SUPPORT_EMAIL = "support@opensourcecalendar.com";
export const PRIVACY_EMAIL = "privacy@opensourcecalendar.com";

const CSS = `
@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:200 800;font-display:swap;src:url(/fonts/plus-jakarta-sans.woff2) format("woff2")}
:root{--brand:#1e40af;--brand-dark:#1e3a8a;--ink:#0f172a;--muted:#475569;--line:#e2e8f0;--bg:#f8fafc;--tint:#e4e9f6;--ok:#0f766e}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.5}
a{color:var(--brand)}a:hover{color:var(--brand-dark)}
:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:16px;z-index:9;background:#fff;padding:8px 12px;border-radius:8px}
.wrap{width:100%;max-width:1160px;margin:0 auto;padding:0 24px}
.band{background:var(--brand);color:#fff}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding-top:20px;padding-bottom:20px}
.logo{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:800;font-size:17px}
.logo:hover{color:#fff}
.logo img{display:block;border-radius:11px;box-shadow:0 0 0 2px rgba(255,255,255,.85)}
.nav{flex-grow:1;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px 20px;font-size:15px;font-weight:600}
.nav a{color:#fff;text-decoration:none;padding:10px 0}.nav a:hover{text-decoration:underline;color:#fff}
.btn{min-height:48px;padding:0 20px;border-radius:14px;font-weight:700;font-size:16px;display:inline-flex;align-items:center;gap:10px;text-decoration:none;border:0;font-family:inherit;cursor:pointer}
.btn-light{background:#fff;color:var(--brand)}.btn-light:hover{color:var(--brand-dark)}
.btn-ghost{border:2px solid rgba(255,255,255,.6);color:#fff}.btn-ghost:hover{color:#fff;border-color:#fff}
.btn-brand{background:var(--brand);color:#fff}.btn-brand:hover{background:var(--brand-dark);color:#fff}
.btn-plain{border:2px solid var(--line);color:var(--ink)}.btn-plain:hover{border-color:var(--muted);color:var(--ink)}
.btn-dark{background:var(--ink);color:#fff}
.hero{display:flex;flex-wrap:wrap;align-items:center;gap:48px;padding-top:40px;padding-bottom:120px}
.hero-text{flex:999 1 460px;min-width:0;display:flex;flex-direction:column;gap:22px}
.pill{align-self:flex-start;font-size:13px;font-weight:700;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.16)}
h1{margin:0;font-size:clamp(38px,6vw,56px);line-height:1.05;font-weight:800;letter-spacing:-.03em}
.lead{margin:0;font-size:19px;line-height:1.55;max-width:34em}
.actions{display:flex;flex-wrap:wrap;gap:12px}
.small{font-size:14px;opacity:.9}
.phone{flex:1 1 300px;max-width:340px;margin:0 auto;background:#fff;color:var(--ink);border-radius:32px;box-shadow:0 30px 60px -24px rgba(15,23,42,.5);overflow:hidden}
.phone-top{background:#0e7490;color:#fff;padding:18px 18px 30px;display:flex;flex-direction:column;gap:10px}
.phone-biz{display:flex;align-items:center;gap:10px;font-weight:700;font-size:14px}
.phone-biz span{width:34px;height:34px;border-radius:11px;background:#fff;color:#0e7490;font-weight:800;font-size:13px;display:grid;place-items:center}
.phone-q{font-size:22px;font-weight:800;line-height:1.15}
.phone-body{margin-top:-18px;background:#fff;border-radius:22px 22px 0 0;padding:16px;display:flex;flex-direction:column;gap:10px}
.phone-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.times{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.times span{height:34px;border-radius:999px;display:grid;place-items:center;font-size:13px;font-weight:600;border:2px solid var(--line)}
.times .on{background:#0e7490;color:#fff;border-color:#0e7490}
.phone-cta{margin-top:6px;height:42px;border-radius:12px;background:#0e7490;color:#fff;font-weight:700;font-size:14px;display:grid;place-items:center}
main{display:block}
.sheet{margin-top:-40px;background:var(--bg);border-radius:32px 32px 0 0;padding-top:72px;position:relative}
.sections{display:flex;flex-direction:column;gap:96px}
h2{margin:0;font-size:clamp(28px,4vw,36px);line-height:1.15;font-weight:800;letter-spacing:-.02em}
h3{margin:0;font-size:18px;font-weight:700}
.intro{display:flex;flex-direction:column;gap:10px;max-width:40em;margin-bottom:32px}
.intro p{margin:0;font-size:17px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:16px}
.card{background:#fff;border:1px solid var(--line);border-radius:22px;padding:22px;display:flex;flex-direction:column;gap:8px}
.card p{margin:0;font-size:15px;line-height:1.55;color:var(--muted)}
.num{align-self:flex-start;font-size:13px;font-weight:800;padding:6px 10px;border-radius:10px;background:var(--tint);color:var(--brand)}
.steps{list-style:none;margin:28px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
.steps li{display:flex;gap:16px;align-items:flex-start}
.steps b{flex-shrink:0;width:44px;height:44px;border-radius:14px;background:var(--brand);color:#fff;font-size:18px;display:grid;place-items:center}
.steps span{display:flex;flex-direction:column;gap:4px;font-size:15px;color:var(--muted);line-height:1.55}
.steps strong{font-size:18px;color:var(--ink)}
.plans{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:16px;align-items:stretch}
.plan{background:#fff;border:1px solid var(--line);border-radius:24px;padding:24px;display:flex;flex-direction:column;gap:10px}
.plan.hi{border:2px solid var(--brand);box-shadow:0 20px 40px -24px var(--brand)}
.plan-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.plan-head h3{font-weight:800}
.badge{font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap;background:#fef3c7;color:#92400e}
.badge.now{background:#dcfce7;color:#166534}
.price{display:flex;align-items:baseline;gap:6px}
.price b{font-size:40px;font-weight:800;letter-spacing:-.02em}
.price span,.per-year{font-size:14px;color:var(--muted)}
.per-year{min-height:20px}
.ticks{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;flex-grow:1}
.ticks li{display:flex;gap:8px;font-size:15px;line-height:1.45}
.ticks svg{flex-shrink:0;margin-top:2px}
.plan .btn{margin-top:8px;justify-content:center}
.note{margin:20px 0 0;font-size:14px;color:var(--muted)}
.dark{background:var(--ink);color:#fff}
.split{display:flex;flex-wrap:wrap;gap:40px;align-items:center}
.split>div{flex:999 1 420px;min-width:0;display:flex;flex-direction:column;gap:14px}
.split p{margin:0;font-size:17px;line-height:1.6}
.dark .wrap{padding-top:72px;padding-bottom:72px}
.dark p{color:#cbd5e1}
.dark .pill{background:rgba(255,255,255,.12)}
.dots{flex:1 1 320px;list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}
.dots li{display:flex;gap:12px;font-size:16px;line-height:1.5}
.dots li::before{content:"";flex-shrink:0;width:10px;height:10px;margin-top:8px;border-radius:3px;background:#5eead4}
.muted{color:var(--muted)}
.code{flex:1 1 340px;min-width:0;background:var(--ink);color:#e2e8f0;border-radius:20px;padding:20px 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;line-height:1.8;overflow-x:auto}
.code i{font-style:normal;color:#94a3b8}.code em{font-style:normal;color:#5eead4}
.faq{max-width:820px}
.faq .card{margin-top:12px}
.wait .wrap{max-width:760px;padding-top:72px;padding-bottom:72px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:16px}
.wait p{margin:0;font-size:17px}
.wait form{width:100%;max-width:480px;display:flex;flex-wrap:wrap;gap:10px}
.wait input[type=email]{flex:1 1 240px;height:52px;padding:0 16px;border:0;border-radius:14px;font:inherit;font-size:16px;color:var(--ink)}
.wait .btn{height:52px}
.hp{position:absolute;left:-9999px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.msg{font-weight:700;background:rgba(255,255,255,.16);padding:10px 16px;border-radius:12px}
footer .wrap{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px 24px;padding-top:28px;padding-bottom:40px;font-size:14px;color:var(--muted)}
footer nav{display:flex;flex-wrap:wrap;gap:8px 20px}
.doc-head{padding-top:24px;padding-bottom:72px}
.doc-head h1{font-size:clamp(34px,5vw,48px)}
.doc-head p{margin:12px 0 0}
.doc{max-width:760px;background:#fff;border:1px solid var(--line);border-radius:24px;padding:clamp(20px,4vw,40px);margin:0 auto 48px}
.doc h2{font-size:24px;margin:36px 0 10px}.doc h2:first-child{margin-top:0}
.doc h3{margin:20px 0 6px}
.doc p,.doc li{line-height:1.65}
.doc ul{padding-left:22px}
.doc li{margin:6px 0}
@media (max-width:640px){.wrap{padding-left:16px;padding-right:16px}.hero{padding-bottom:96px}.sections{gap:72px}.nav{justify-content:flex-start}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;

function header(onHome: boolean) {
  const h = onHome ? "" : "/";
  return `<a class="skip" href="#main">Skip to content</a>
<div class="wrap top">
<a class="logo" href="/"><img src="/favicon.svg" width="36" height="36" alt="">${SITE_NAME}</a>
<nav class="nav" aria-label="Main"><a href="${h}#features">Features</a><a href="${h}#pricing">Pricing</a><a href="${h}#agencies">White-label</a><a href="${GITHUB_URL}">GitHub</a></nav>
<a class="btn btn-light" href="${h}#waitlist">Join the waitlist</a>
</div>`;
}

const FOOTER = `<footer><div class="wrap">
<span>© ${new Date().getUTCFullYear()} ${SITE_NAME}</span>
<nav aria-label="Footer"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="${GITHUB_URL}">GitHub</a><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></nav>
</div></footer>`;

/** A whole page. `band` is what goes in the brand-colored top after the header; `body` follows in the light sheet. */
export function page(opts: { title: string; description: string; path: string; band: string; body: string }) {
  const onHome = opts.path === "/";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<meta name="description" content="${opts.description}">
<link rel="canonical" href="https://opensourcecalendar.com${opts.path}">
<meta name="theme-color" content="#1e40af">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Open Source Calendar","url":"https://opensourcecalendar.com","logo":"https://opensourcecalendar.com/logo-512.png"}</script>
<link rel="preload" href="/fonts/plus-jakarta-sans.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style>
</head>
<body>
<div class="band">${header(onHome)}${opts.band}</div>
<main id="main" class="sheet">${opts.body}${FOOTER}</main>
</body>
</html>`;
}
