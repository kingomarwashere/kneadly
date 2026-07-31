import { Hono } from 'hono'
import { layout, siteNav, esc } from '../lib/views.js'
import { genId } from '../lib/auth.js'
import { formatBookingTime, dateTzString } from '../lib/slots.js'

// Therapist self-service portal. No password — access is via a secret per-staff
// token link the owner shares. Here a therapist sets their own weekly hours and
// marks days off, and sees their upcoming appointments.
const app = new Hono()
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Resolve the staff member (+ their shop) from the token for every route.
app.use('/:token/*', loadStaff)
app.use('/:token', loadStaff)
async function loadStaff(c, next) {
  const token = c.req.param('token')
  const staff = token && await c.env.DB.prepare('SELECT * FROM staff WHERE token = ?').bind(token).first()
  if (!staff) return c.html(notFoundPage(c), 404)
  const shop = await c.env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(staff.shop_id).first()
  if (!shop) return c.html(notFoundPage(c), 404)
  c.set('staff', staff)
  c.set('shop', shop)
  await next()
}

function notFoundPage(c) {
  return layout('Link not found — Alisa', `${siteNav(null, c.get('lang'))}
    <div class="wrap narrow" style="padding:60px 20px;text-align:center">
      <div style="font-size:2.5rem">🔒</div>
      <h2>This scheduling link isn’t valid</h2>
      <p class="muted">Ask your shop manager for your personal scheduling link.</p>
    </div>`, { lang: c.get('lang') })
}

app.get('/:token', async (c) => {
  const db = c.env.DB, staff = c.get('staff'), shop = c.get('shop'), lang = c.get('lang')
  const saved = c.req.query('saved')

  const hours = (await db.prepare('SELECT * FROM availability WHERE staff_id = ? ORDER BY day_of_week').bind(staff.id).all()).results || []
  const hByDow = Object.fromEntries(hours.map(h => [h.day_of_week, h]))

  const today = dateTzString(new Date(), shop.timezone)
  const off = (await db.prepare('SELECT * FROM time_off WHERE staff_id = ? AND date >= ? ORDER BY date').bind(staff.id, today).all()).results || []

  const nowUnix = Math.floor(Date.now() / 1000)
  const upcoming = (await db.prepare(
    `SELECT * FROM bookings WHERE staff_id = ? AND status IN ('confirmed','pending_payment') AND start_time > ?
     ORDER BY start_time LIMIT 20`).bind(staff.id, nowUnix).all()).results || []

  return c.html(layout(`My schedule — ${shop.name}`, `
  ${siteNav(null, lang)}
  <div class="wrap" style="padding:24px 20px;max-width:760px">
    <div class="inline" style="gap:10px">
      <span style="font-size:1.8rem">${esc(staff.emoji)}</span>
      <div><h2 style="margin:0">Hi ${esc(staff.name.split(' ')[0])} 👋</h2>
      <div class="muted">${esc(staff.title || 'Therapist')} · ${esc(shop.name)}</div></div>
    </div>

    ${saved ? `<div class="notice ok" style="margin-top:16px">Saved ✓ Your booking page is updated.</div>` : ''}

    <div class="card" style="padding:22px;margin-top:18px">
      <h3 style="margin-top:0">🗓️ My weekly hours</h3>
      <p class="muted" style="font-size:.88rem;margin-top:0">Tick the days you work and set your start/end times. Customers can only book you inside these hours.</p>
      <form method="post" action="/t/${staff.token}/hours">
        <table style="margin-bottom:12px"><tr><th></th><th>Working</th><th>Start</th><th>End</th></tr>
        ${DOW.map((d, i) => {
          const h = hByDow[i]
          return `<tr><td><strong>${d}</strong></td>
            <td><input type="checkbox" name="on_${i}" ${h ? 'checked' : ''} style="width:auto"></td>
            <td><input type="time" name="start_${i}" value="${h?.start_time || '09:00'}" style="max-width:130px"></td>
            <td><input type="time" name="end_${i}" value="${h?.end_time || '18:00'}" style="max-width:130px"></td></tr>`
        }).join('')}</table>
        <button class="btn">Save my hours</button>
      </form>
    </div>

    <div class="card" style="padding:22px;margin-top:18px">
      <h3 style="margin-top:0">🌴 Days off</h3>
      <p class="muted" style="font-size:.88rem;margin-top:0">Block a specific date (holiday, sick day). You won’t be bookable that day even if it’s in your weekly hours.</p>
      <form method="post" action="/t/${staff.token}/timeoff" class="inline" style="align-items:flex-end;margin-bottom:${off.length ? '16px' : '0'}">
        <div class="field" style="margin:0"><label>Date</label><input type="date" name="date" min="${today}" required style="max-width:180px"></div>
        <div class="field" style="margin:0;flex:1"><label>Reason (optional)</label><input name="reason" placeholder="Holiday" style="min-width:140px"></div>
        <button class="btn sm">Add day off</button>
      </form>
      ${off.length ? `<table><tr><th>Date</th><th>Reason</th><th></th></tr>
        ${off.map(o => `<tr><td><strong>${esc(niceDate(o.date))}</strong></td><td class="muted">${esc(o.reason || '')}</td>
          <td style="text-align:right"><form method="post" action="/t/${staff.token}/timeoff/${o.id}/delete"><button class="btn ghost sm">Remove</button></form></td></tr>`).join('')}
      </table>` : ''}
    </div>

    <div class="card" style="padding:22px;margin-top:18px">
      <h3 style="margin-top:0">📅 My upcoming appointments</h3>
      ${upcoming.length ? `<table><tr><th>When</th><th>Service</th><th>Client</th></tr>
        ${upcoming.map(b => `<tr><td>${formatBookingTime(b.start_time, shop.timezone)}</td><td>${esc(b.service_name)}</td>
          <td>${esc(b.customer_name)}${b.customer_phone ? `<div class="muted" style="font-size:.8rem">${esc(b.customer_phone)}</div>` : ''}</td></tr>`).join('')}
      </table>` : '<p class="muted" style="margin:0">No upcoming appointments yet.</p>'}
    </div>

    <p class="muted" style="font-size:.78rem;margin-top:18px">🔒 This is your private link — keep it to yourself. Anyone with it can change your hours.</p>
  </div>`, { lang }))
})

app.post('/:token/hours', async (c) => {
  const db = c.env.DB, staff = c.get('staff')
  const f = await c.req.parseBody()
  await db.prepare('DELETE FROM availability WHERE staff_id = ?').bind(staff.id).run()
  for (let i = 0; i < 7; i++) {
    if (!f[`on_${i}`]) continue
    const start = (f[`start_${i}`] || '09:00').toString(), end = (f[`end_${i}`] || '18:00').toString()
    if (end <= start) continue
    await db.prepare('INSERT INTO availability (id, staff_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
      .bind(genId(), staff.id, i, start, end).run()
  }
  return c.redirect(`/t/${staff.token}?saved=1`)
})

app.post('/:token/timeoff', async (c) => {
  const db = c.env.DB, staff = c.get('staff')
  const f = await c.req.parseBody()
  const date = (f.date || '').toString().trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    await db.prepare('INSERT OR IGNORE INTO time_off (id, staff_id, date, reason) VALUES (?, ?, ?, ?)')
      .bind(genId(), staff.id, date, (f.reason || '').toString().trim() || null).run()
  }
  return c.redirect(`/t/${staff.token}?saved=1`)
})

app.post('/:token/timeoff/:id/delete', async (c) => {
  const db = c.env.DB, staff = c.get('staff')
  await db.prepare('DELETE FROM time_off WHERE id = ? AND staff_id = ?').bind(c.req.param('id'), staff.id).run()
  return c.redirect(`/t/${staff.token}?saved=1`)
})

function niceDate(ds) {
  return new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}

export default app
