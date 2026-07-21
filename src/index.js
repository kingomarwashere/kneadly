import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { getSession } from './lib/auth.js'
import authRoutes from './routes/auth.js'
import dashboardRoutes from './routes/dashboard.js'
import apiRoutes from './routes/api.js'
import webhookRoutes from './routes/webhooks.js'
import publicRoutes from './routes/public.js'

const app = new Hono()

// Attach logged-in owner (if any) to the request context
app.use('*', async (c, next) => {
  const sessionId = getCookie(c, 'kneadly_session')
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
  <text x="90" y="250" font-family="Georgia,serif" font-weight="600" font-size="120" fill="#faf8f5">💆 Kneadly</text>
  <text x="96" y="330" font-family="Georgia,serif" font-size="42" fill="#c99b5b">Online booking for massage shops</text>
  <text x="96" y="405" font-family="monospace" font-size="24" fill="#a7d3ce">Take bookings from Google Maps · Collect deposits · Fill your calendar</text>
  <rect x="96" y="470" width="360" height="70" rx="35" fill="#c99b5b"/>
  <text x="130" y="515" font-family="Georgia,serif" font-size="30" fill="#241a08" font-weight="600">Start free →</text>
</svg>`
  return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' })
})

app.get('/robots.txt', (c) => {
  const base = c.env.BASE_URL || 'https://kneadly.theradicalparty.com'
  return c.text(`User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /api\nDisallow: /webhooks\nSitemap: ${base}/sitemap.xml`)
})

app.get('/sitemap.xml', async (c) => {
  const base = c.env.BASE_URL || 'https://kneadly.theradicalparty.com'
  const rows = await c.env.DB.prepare(
    `SELECT slug FROM shops WHERE is_published = 1 ORDER BY created_at DESC`).all()
  const urls = [`<url><loc>${base}/</loc><priority>1.0</priority></url>`]
  for (const r of (rows.results || []))
    urls.push(`<url><loc>${base}/${r.slug}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`)
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`,
    200, { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' })
})

app.get('/healthz', (c) => c.json({ ok: true, app: 'kneadly' }))

// ─── Routes ──────────────────────────────────────────────────────────────────
app.route('/api', apiRoutes)
app.route('/webhooks', webhookRoutes)
app.route('/', authRoutes)
app.route('/dashboard', dashboardRoutes)
app.route('/', publicRoutes)   // shop pages + booking flow live at the root, keep last

export default app
