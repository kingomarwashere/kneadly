// Shared layout + design system for Alisa

import { t, langSwitcher } from './i18n.js'

export const money = (cents, currency = 'aud') =>
  new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency.toUpperCase() }).format((cents || 0) / 100)

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const BASE_CSS = `
:root{
  --bg:#faf8f5; --card:#ffffff; --ink:#1c2b2a; --muted:#6b7c7a; --line:#e8e2da;
  --accent:#0f766e; --accent-ink:#0b5750; --gold:#c99b5b; --danger:#c0492f; --ok:#2f8a5b;
  --radius:16px; --shadow:0 1px 2px rgba(28,43,42,.05),0 10px 30px rgba(28,43,42,.06);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink);line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
.narrow{max-width:560px}
h1,h2,h3{font-family:'Fraunces','Georgia',serif;font-weight:600;letter-spacing:-.02em;line-height:1.15;margin:0 0 .4em}
h1{font-size:clamp(2rem,5vw,3.2rem)}
h2{font-size:1.6rem}
.muted{color:var(--muted)}
.pill{display:inline-block;padding:4px 12px;border-radius:999px;font-size:.78rem;font-weight:600;background:#eef4f3;color:var(--accent-ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.btn{display:inline-flex;align-items:center;gap:8px;justify-content:center;padding:12px 22px;border-radius:999px;border:1px solid transparent;font-weight:600;font-size:.98rem;cursor:pointer;transition:.15s;background:var(--accent);color:#fff;text-decoration:none}
.btn:hover{background:var(--accent-ink);text-decoration:none;transform:translateY(-1px)}
.btn.ghost{background:#fff;color:var(--ink);border-color:var(--line)}
.btn.ghost:hover{background:#f4f0ea;transform:none}
.btn.gold{background:var(--gold);color:#241a08}
.btn.danger{background:#fff;color:var(--danger);border-color:#e7c6bd}
.btn.sm{padding:7px 14px;font-size:.85rem}
.btn:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(15,118,110,.12)}
label{display:block;font-size:.85rem;font-weight:600;margin:0 0 6px;color:var(--ink)}
.field{margin-bottom:16px}
.row{display:flex;gap:14px;flex-wrap:wrap}
.row>*{flex:1;min-width:120px}
.grid{display:grid;gap:18px}
@media(min-width:720px){.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}}
.nav{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.brand{font-family:'Fraunces',serif;font-weight:600;font-size:1.4rem;color:var(--ink);display:flex;align-items:center;gap:8px}
.brand:hover{text-decoration:none}
.langsel{width:auto;padding:7px 10px;font-size:.85rem;border-radius:999px;background:#fff;color:var(--ink);border:1px solid var(--line);cursor:pointer}
.notice{padding:12px 16px;border-radius:12px;margin-bottom:16px;font-size:.9rem}
.notice.err{background:#fbeae5;color:var(--danger)}
.notice.ok{background:#e4f3ea;color:var(--ok)}
.tag{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:3px 9px;border-radius:6px}
.tag.pending_payment{background:#fdf1dc;color:#8a6414}
.tag.confirmed{background:#e0efff;color:#1e5aa8}
.tag.completed{background:#e4f3ea;color:var(--ok)}
.tag.cancelled{background:#f0eeec;color:#7a736c}
.tag.no_show{background:#fbeae5;color:var(--danger)}
footer{border-top:1px solid var(--line);margin-top:60px;padding:30px 0;color:var(--muted);font-size:.85rem}
`

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">`

export function layout(title, body, opts = {}) {
  const desc = opts.description || 'Online booking for massage & bodywork. Fill your calendar, take deposits, and let clients book from Google in seconds.'
  const accent = opts.accent
  const lang = opts.lang || 'en'
  return `<!DOCTYPE html><html lang="${lang}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:image" content="/og.svg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg">
${FONTS}
${opts.jsonld ? `<script type="application/ld+json">${JSON.stringify(opts.jsonld)}</script>` : ''}
<style>${BASE_CSS}${accent ? `:root{--accent:${accent};--accent-ink:${accent}}` : ''}${opts.css || ''}</style>
</head><body>${body}
<footer><div class="wrap">${t(lang, 'powered_by')} <a href="/">Alisa</a> · ${t(lang, 'footer_tagline')}</div></footer>
</body></html>`
}

export function siteNav(user, lang = 'en') {
  return `<div class="wrap"><nav class="nav">
    <a class="brand" href="/">💆 Alisa</a>
    <div class="row" style="flex:0;align-items:center">
      ${langSwitcher(lang)}
      ${user
        ? `<a class="btn ghost sm" href="/dashboard">${t(lang, 'dashboard')}</a>`
        : `<a class="btn ghost sm" href="/login">${t(lang, 'login')}</a><a class="btn sm" href="/signup">${t(lang, 'signup')}</a>`}
    </div>
  </nav></div>`
}
