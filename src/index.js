import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { getSession } from './lib/auth.js'
import { resolveLang } from './lib/i18n.js'
import { runReminders } from './lib/email.js'
import { ICONS, pngResponse } from './lib/icons.js'
import { layout } from './lib/views.js'
import authRoutes from './routes/auth.js'
import dashboardRoutes from './routes/dashboard.js'
import apiRoutes from './routes/api.js'
import webhookRoutes from './routes/webhooks.js'
import therapistRoutes from './routes/therapist.js'
import proRoutes from './routes/pro.js'
import publicRoutes from './routes/public.js'

const app = new Hono()

// Canonical-domain redirect: the app rebranded from Kneadly to Alisa. Both old
// Kneadly hosts (theradicalparty.com and bored.investments) stay alive so
// existing links — including Google Maps booking links — 301 across to the new
// canonical Alisa domain.
const OLD_HOSTS = new Set(['kneadly.theradicalparty.com', 'kneadly.bored.investments'])
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  // Skip machine endpoints: Stripe webhooks + API callers don't follow 301s,
  // and every host hits the same Worker + D1, so those keep working on any
  // domain until integrations are repointed.
  const machine = url.pathname.startsWith('/webhooks') || url.pathname.startsWith('/api')
  if (OLD_HOSTS.has(url.hostname) && !machine) {
    url.hostname = 'alisa.bored.investments'
    return c.redirect(url.toString(), 301)
  }
  await next()
})

// Resolve the visitor's language (?lang= → cookie → Accept-Language → English)
// and stash it on the context for every view to read.
app.use('*', async (c, next) => {
  c.set('lang', resolveLang(c))
  await next()
})

// Attach logged-in owner (if any) to the request context
app.use('*', async (c, next) => {
  const sessionId = getCookie(c, 'alisa_session')
  if (sessionId) {
    const user = await getSession(c.env.DB, sessionId)
    if (user) c.set('user', user)
  }
  await next()
})

// ─── Static assets ───────────────────────────────────────────────────────────
app.get('/favicon.svg', (c) =>
  c.body(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💆</text></svg>`,
    200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }))

app.get('/og.svg', (c) => {
  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#0f766e"/>
  <rect width="1200" height="630" fill="url(#g)"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#0b5750"/></linearGradient></defs>
  <text x="90" y="250" font-family="Georgia,serif" font-weight="600" font-size="120" fill="#faf8f5">💆 Alisa</text>
  <text x="96" y="330" font-family="Georgia,serif" font-size="42" fill="#c99b5b">Online booking for massage shops</text>
  <text x="96" y="405" font-family="monospace" font-size="24" fill="#a7d3ce">Take bookings from Google Maps · Collect deposits · Fill your calendar</text>
  <rect x="96" y="470" width="360" height="70" rx="35" fill="#c99b5b"/>
  <text x="130" y="515" font-family="Georgia,serif" font-size="30" fill="#241a08" font-weight="600">Start free →</text>
</svg>`
  return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' })
})

// ─── PWA (installable, but caches NOTHING) ───────────────────────────────────
app.get('/icon-512.png', (c) => pngResponse(ICONS[512]))
app.get('/icon-192.png', (c) => pngResponse(ICONS[192]))
app.get('/apple-touch-icon.png', (c) => pngResponse(ICONS[180]))
app.get('/apple-touch-icon-precomposed.png', (c) => pngResponse(ICONS[180]))

app.get('/manifest.webmanifest', (c) => c.body(JSON.stringify({
  name: 'Alisa', short_name: 'Alisa',
  description: 'Booking manager for your massage shop.',
  start_url: '/dashboard', scope: '/', display: 'standalone',
  background_color: '#0a5249', theme_color: '#0f766e', orientation: 'any',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}), 200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' }))

// Network-only service worker — required for installability, but deliberately
// caches nothing so users always get the freshest version.
app.get('/sw.js', (c) => c.body(
  `self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{e.respondWith(fetch(e.request));});`,
  200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }))

app.get('/robots.txt', (c) => {
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
  return c.text(`User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /api\nDisallow: /webhooks\nSitemap: ${base}/sitemap.xml`)
})

app.get('/sitemap.xml', async (c) => {
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
  const rows = await c.env.DB.prepare(
    `SELECT slug FROM shops WHERE is_published = 1 ORDER BY created_at DESC`).all()
  const urls = [`<url><loc>${base}/</loc><priority>1.0</priority></url>`]
  for (const r of (rows.results || []))
    urls.push(`<url><loc>${base}/${r.slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`)
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`,
    200, { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' })
})

// Public thank-you page a customer lands on after paying via a QR/link.
app.get('/pay/thanks', (c) => {
  const cancelled = c.req.query('cancelled')
  return c.html(layout(cancelled ? 'Payment cancelled' : 'Payment received', `
  <div class="wrap narrow" style="padding:64px 20px;text-align:center">
    <div style="font-size:3.4rem">${cancelled ? '↩︎' : '✅'}</div>
    <h1 style="font-size:1.8rem;margin:.3em 0">${cancelled ? 'Payment cancelled' : 'Payment received'}</h1>
    <p class="muted">${cancelled ? 'No charge was made — you can close this page.' : 'Thank you! Your payment went through. You can close this page.'}</p>
  </div>`, {}))
})

app.get('/healthz', (c) => c.json({ ok: true, app: 'alisa' }))

// ─── Routes ──────────────────────────────────────────────────────────────────
app.route('/api', apiRoutes)
app.route('/webhooks', webhookRoutes)
app.route('/', authRoutes)
app.route('/dashboard', dashboardRoutes)
app.route('/t', therapistRoutes)   // therapist self-service (secret token links)
app.route('/pro', proRoutes)       // therapist login accounts (multi-shop)
app.route('/', publicRoutes)   // shop pages + booking flow live at the root, keep last

// Cron: send day-before appointment reminders (see wrangler.toml [triggers]).
export default {
  fetch: app.fetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env))
  },
}
