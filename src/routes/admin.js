import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { layout, esc, money } from '../lib/views.js'

const app = new Hono()

// ── Simple password gate ──────────────────────────────────────────────────────
const adminPass = (c) => c.env.ADMIN_PASSWORD || 'alisa1'
async function token(c) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('alisa-admin:' + adminPass(c)))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}
async function authed(c) { return getCookie(c, 'alisa_admin') === (await token(c)) }

const ADMIN_CSS = `
  .wrap{max-width:1180px}
  .stat{display:flex;flex-direction:column;gap:2px}
  .stat .n{font-family:'Fraunces',serif;font-size:1.7rem;font-weight:600;line-height:1}
  .stat .l{color:var(--muted);font-size:.8rem}
  .grid4{display:grid;gap:14px;grid-template-columns:repeat(2,1fr)}
  @media(min-width:760px){.grid4{grid-template-columns:repeat(4,1fr)}}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:.86rem;vertical-align:top;white-space:nowrap}
  th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  td.r,th.r{text-align:right}
  .pill2{font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:6px}
  .on{background:#e4f3ea;color:#2f8a5b}.off{background:#f0eeec;color:#7a736c}
  .tblcard{overflow-x:auto}
`

function loginPage(err) {
  return layout('Admin', `
  <div class="wrap narrow" style="padding:70px 20px">
    <h1 style="font-size:1.6rem">🔐 Alisa Admin</h1>
    ${err ? `<div class="notice err">${esc(err)}</div>` : ''}
    <form method="post" action="/admin/login" class="card" style="padding:22px;max-width:360px">
      <div class="field"><label>Password</label><input type="password" name="password" autofocus required></div>
      <button class="btn">Enter</button>
    </form>
  </div>`, {})
}

app.post('/login', async (c) => {
  const f = await c.req.parseBody()
  if ((f.password || '').toString() === adminPass(c)) {
    setCookie(c, 'alisa_admin', await token(c), { httpOnly: true, secure: true, sameSite: 'Lax', path: '/admin', maxAge: 60 * 60 * 24 * 30 })
    return c.redirect('/admin')
  }
  return c.html(loginPage('Wrong password.'))
})

app.get('/logout', (c) => { setCookie(c, 'alisa_admin', '', { path: '/admin', maxAge: 0 }); return c.redirect('/admin') })

app.get('/', async (c) => {
  if (!(await authed(c))) return c.html(loginPage())
  const db = c.env.DB

  const shops = (await db.prepare(`
    SELECT s.id, s.name, s.slug, s.currency, s.deposit_pct, s.is_published, s.created_at,
      s.stripe_account_id, s.stripe_charges_enabled, u.email owner_email,
      (SELECT COUNT(*) FROM bookings b WHERE b.shop_id=s.id AND b.status!='cancelled') bookings,
      (SELECT COALESCE(SUM(price_cents),0) FROM bookings b WHERE b.shop_id=s.id AND b.status!='cancelled') value_cents,
      (SELECT COALESCE(SUM(deposit_cents),0) FROM bookings b WHERE b.shop_id=s.id AND b.stripe_charge_id IS NOT NULL AND b.refunded_at IS NULL) deposits_cents,
      (SELECT COALESCE(SUM(paid_cents),0) FROM bookings b WHERE b.shop_id=s.id) paid_cents,
      (SELECT COUNT(*) FROM clients cl WHERE cl.shop_id=s.id) clients,
      (SELECT COUNT(*) FROM staff st WHERE st.shop_id=s.id AND st.is_active=1) staff
    FROM shops s LEFT JOIN users u ON u.id=s.owner_id
    ORDER BY s.created_at DESC`).all()).results || []

  const tot = (k) => shops.reduce((a, s) => a + (s[k] || 0), 0)
  const totals = {
    shops: shops.length,
    published: shops.filter(s => s.is_published).length,
    connected: shops.filter(s => s.stripe_account_id && s.stripe_charges_enabled).length,
    bookings: tot('bookings'),
    value: tot('value_cents'),
    processed: tot('deposits_cents') + tot('paid_cents'),
    clients: tot('clients'),
  }
  const fee = Math.round(totals.processed * 0.01)

  const platform = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM users) users,
    (SELECT COUNT(*) FROM therapists) therapists,
    (SELECT COUNT(*) FROM bookings WHERE status IN ('confirmed','pending_payment') AND start_time>unixepoch()) upcoming,
    (SELECT COUNT(*) FROM bookings WHERE status='completed') completed`).first()

  const recent = (await db.prepare(`SELECT b.customer_name, b.service_name, b.price_cents, b.status, b.start_time, b.created_at, s.name shop, s.currency
    FROM bookings b JOIN shops s ON s.id=b.shop_id ORDER BY b.created_at DESC LIMIT 15`).all()).results || []

  const fdate = (ts) => new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
  const card = (n, l) => `<div class="card" style="padding:16px 18px"><div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div></div>`
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'

  return c.html(layout('Alisa Admin', `
  <div class="wrap" style="padding:20px">
    <div class="inline" style="justify-content:space-between;align-items:center;margin-bottom:16px">
      <h1 style="font-size:1.5rem;margin:0">🛠️ Alisa Admin</h1>
      <a class="btn ghost sm" href="/admin/logout">Log out</a>
    </div>

    <div class="grid4" style="margin-bottom:14px">
      ${card(totals.shops, 'Shops signed up')}
      ${card(totals.published, 'Published / live')}
      ${card(totals.connected, 'Stripe connected')}
      ${card(platform.users, 'Owner accounts')}
    </div>
    <div class="grid4" style="margin-bottom:22px">
      ${card(money(totals.processed, 'aud'), 'Money processed (Stripe)')}
      ${card(money(fee, 'aud'), 'Est. platform fees (1%)')}
      ${card(money(totals.value, 'aud'), 'Total booking value')}
      ${card(totals.bookings, 'Bookings (' + platform.upcoming + ' upcoming)')}
    </div>

    <h2 style="font-size:1.15rem">Shops <span class="muted" style="font-size:.8rem;font-weight:400">· newest first · money shown in each shop’s currency</span></h2>
    <div class="card tblcard" style="padding:4px 14px;margin-bottom:24px">
      <table>
        <tr><th>Shop</th><th>Owner</th><th>Joined</th><th>Live</th><th>Stripe</th><th class="r">Bookings</th><th class="r">Value</th><th class="r">Deposits</th><th class="r">QR pay</th><th class="r">Clients</th><th class="r">Staff</th></tr>
        ${shops.map(s => `<tr>
          <td><strong>${esc(s.name)}</strong><div class="muted" style="font-size:.76rem"><a href="${base}/${esc(s.slug)}" target="_blank">/${esc(s.slug)}</a></div></td>
          <td>${esc(s.owner_email || '—')}</td>
          <td>${fdate(s.created_at)}</td>
          <td>${s.is_published ? '<span class="pill2 on">live</span>' : '<span class="pill2 off">draft</span>'}</td>
          <td>${s.stripe_account_id ? (s.stripe_charges_enabled ? '<span class="pill2 on">on</span>' : '<span class="pill2 off">setup</span>') : '<span class="pill2 off">—</span>'}</td>
          <td class="r">${s.bookings}</td>
          <td class="r">${money(s.value_cents, s.currency)}</td>
          <td class="r">${s.deposits_cents ? money(s.deposits_cents, s.currency) : '—'}</td>
          <td class="r">${s.paid_cents ? money(s.paid_cents, s.currency) : '—'}</td>
          <td class="r">${s.clients}</td>
          <td class="r">${s.staff}</td>
        </tr>`).join('')}
      </table>
    </div>

    <h2 style="font-size:1.15rem">Latest bookings</h2>
    <div class="card tblcard" style="padding:4px 14px">
      <table>
        <tr><th>Booked</th><th>Shop</th><th>Client</th><th>Service</th><th class="r">Price</th><th>Status</th></tr>
        ${recent.map(r => `<tr>
          <td>${fdate(r.created_at)}</td>
          <td>${esc(r.shop)}</td>
          <td>${esc(r.customer_name)}</td>
          <td>${esc(r.service_name || '')}</td>
          <td class="r">${money(r.price_cents || 0, r.currency)}</td>
          <td><span class="pill2 ${['completed', 'confirmed'].includes(r.status) ? 'on' : 'off'}">${r.status.replace('_', ' ')}</span></td>
        </tr>`).join('')}
      </table>
    </div>
  </div>`, { css: ADMIN_CSS }))
})

export default app
