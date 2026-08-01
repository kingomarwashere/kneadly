import { Hono } from 'hono'
import { layout, money, esc } from '../lib/views.js'
import { genId } from '../lib/auth.js'
import { formatBookingTime, dateTzString, localToUtcMs } from '../lib/slots.js'
import { stripeClient } from '../lib/stripe.js'
import { sendCancellationEmail, sendBookingEmails, sendRescheduleEmail } from '../lib/email.js'
import { findOrCreateClient } from '../lib/clients.js'

const app = new Hono()
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Short date label like "Mon 3 Aug" from a YYYY-MM-DD string
const niceOff = (ds) => new Date(ds + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
// Just the time, e.g. "2:30 PM", in a timezone
const timeOnly = (unix, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(unix * 1000))
// Add whole days to a YYYY-MM-DD (anchored at noon UTC so DST can't shift the date)
const addDays = (ds, n) => new Date(new Date(ds + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10)

// Guard + load the owner's shop for every dashboard route
app.use('*', async (c, next) => {
  const user = c.get('user')
  if (!user) return c.redirect('/login')
  const shop = await c.env.DB.prepare('SELECT * FROM shops WHERE owner_id = ?').bind(user.user_id).first()
  if (!shop) return c.redirect('/signup')
  c.set('shop', shop)
  await next()
})

function shell(c, active, title, body, notice) {
  const shop = c.get('shop')
  const tab = (id, label) => `<a href="/dashboard${id ? '/' + id : ''}" class="dtab${active === id ? ' on' : ''}">${label}</a>`
  return c.html(layout(`${title} — Alisa`, `
  <div class="dwrap">
    <aside class="dside">
      <a class="brand" href="/dashboard" style="padding:6px 10px 14px">💆 Alisa</a>
      ${tab('', '📊 Overview')}
      ${tab('roster', '📅 Roster')}
      ${tab('bookings', '🗓️ Bookings')}
      ${tab('clients', '👤 Clients')}
      ${tab('services', '💆 Services')}
      ${tab('staff', '🧑‍⚕️ Therapists')}
      ${tab('settings', '⚙️ Settings')}
      <div style="flex:1"></div>
      <a class="dtab" href="/${shop.slug}" target="_blank">🔗 View my page</a>
      <a class="dtab" href="/logout">↩︎ Log out</a>
    </aside>
    <main class="dmain">
      ${notice ? `<div class="notice ok">${esc(notice)}</div>` : ''}
      ${body}
    </main>
  </div>`, {
    lang: c.get('lang'),
    css: `
    .dwrap{display:flex;min-height:100vh;max-width:1200px;margin:0 auto}
    .dside{width:220px;flex:0 0 220px;padding:18px 12px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh}
    .dtab{padding:10px 12px;border-radius:10px;color:var(--ink);font-weight:500;font-size:.92rem}
    .dtab:hover{background:#f1ece5;text-decoration:none}
    .dtab.on{background:var(--accent);color:#fff}
    .dmain{flex:1;padding:26px 30px;min-width:0}
    .stat{font-family:'Fraunces',serif;font-size:2rem;font-weight:600}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);font-size:.9rem;vertical-align:top}
    th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
    .inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    @media(max-width:720px){.dwrap{flex-direction:column}.dside{width:auto;flex:none;height:auto;position:static;flex-direction:row;flex-wrap:wrap;border-right:none;border-bottom:1px solid var(--line)}.dside>div{display:none}}
    `
  }))
}

const upcomingWhere = `status IN ('confirmed','pending_payment') AND start_time > unixepoch()`

// ─── Overview ────────────────────────────────────────────────────────────────
app.get('/', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
  const link = `${base}/${shop.slug}`
  const welcome = c.req.query('welcome')

  const upcoming = (await db.prepare(
    `SELECT * FROM bookings WHERE shop_id = ? AND ${upcomingWhere} ORDER BY start_time LIMIT 6`).bind(shop.id).all()).results || []
  const counts = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM bookings WHERE shop_id=?1 AND ${upcomingWhere}) AS upcoming,
      (SELECT COUNT(*) FROM bookings WHERE shop_id=?1 AND status='completed') AS done,
      (SELECT COALESCE(SUM(deposit_cents),0) FROM bookings WHERE shop_id=?1 AND status IN ('confirmed','completed')) AS deposits,
      (SELECT COUNT(*) FROM services WHERE shop_id=?1 AND is_active=1) AS services,
      (SELECT COUNT(*) FROM staff WHERE shop_id=?1 AND is_active=1) AS staff`).bind(shop.id).first()

  const setup = counts.services === 0 || counts.staff === 0

  return shell(c, '', 'Overview', `
    <h2>Welcome back 👋</h2>
    ${welcome ? `<div class="notice ok">Your booking page is live! Add your services below, then share your link.</div>` : ''}

    <div class="card" style="padding:20px;margin-bottom:20px">
      <label>Your booking link</label>
      <div class="inline">
        <input id="link" value="${esc(link)}" readonly style="max-width:420px">
        <button class="btn ghost sm" onclick="navigator.clipboard.writeText(document.getElementById('link').value);this.textContent='Copied ✓'">Copy</button>
        <a class="btn ghost sm" href="${esc(link)}" target="_blank">Open</a>
      </div>
    </div>

    <div class="grid g3" style="margin-bottom:20px">
      <div class="card" style="padding:18px"><div class="muted">Upcoming</div><div class="stat">${counts.upcoming}</div></div>
      <div class="card" style="padding:18px"><div class="muted">Completed</div><div class="stat">${counts.done}</div></div>
      <div class="card" style="padding:18px"><div class="muted">Deposits collected</div><div class="stat">${money(counts.deposits, shop.currency)}</div></div>
    </div>

    ${setup ? `<div class="card" style="padding:20px;margin-bottom:20px;border-color:var(--gold)">
      <strong>Finish setting up:</strong>
      <ul style="margin:8px 0 0">
        ${counts.services === 0 ? '<li>Add at least one <a href="/dashboard/services">service</a>.</li>' : ''}
        ${counts.staff === 0 ? '<li>Add a <a href="/dashboard/staff">therapist</a> with working hours.</li>' : ''}
      </ul></div>` : ''}

    <div class="card" style="padding:20px;margin-bottom:20px;background:#f6f2ec;border-style:dashed">
      <h3 style="margin:0 0 6px;font-size:1.05rem">📍 Get bookings from Google Maps</h3>
      <p class="muted" style="margin:0 0 10px;font-size:.9rem">In your <a href="https://business.google.com" target="_blank">Google Business Profile</a> → <strong>Edit profile → Booking / Appointment links</strong>, paste this URL. Customers will see a <strong>“Book”</strong> button on your Maps listing.</p>
      <div class="inline"><input value="${esc(link)}" readonly style="max-width:420px"><button class="btn ghost sm" onclick="navigator.clipboard.writeText('${esc(link)}');this.textContent='Copied ✓'">Copy link</button></div>
    </div>

    <h3>Next appointments</h3>
    ${upcoming.length ? `<div class="card" style="padding:6px 18px"><table>
      <tr><th>When</th><th>Service</th><th>Client</th><th>Therapist</th><th></th></tr>
      ${upcoming.map(b => `<tr><td>${formatBookingTime(b.start_time, shop.timezone)}</td><td>${esc(b.service_name)}</td><td>${esc(b.customer_name)}</td><td>${esc(b.staff_name || '')}</td><td><span class="tag ${b.status}">${b.status.replace('_', ' ')}</span></td></tr>`).join('')}
    </table></div>` : '<p class="muted">No upcoming bookings yet — share your link to get started.</p>'}
  `)
})

// ─── Roster (week calendar) ──────────────────────────────────────────────────
app.get('/roster', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), tz = shop.timezone

  // Work out the Monday of the week being viewed.
  const today = dateTzString(new Date(), tz)
  const dowToday = new Date(today + 'T12:00:00Z').getUTCDay()      // 0=Sun..6=Sat
  const thisMonday = addDays(today, dowToday === 0 ? -6 : 1 - dowToday)
  const reqWeek = c.req.query('week')
  const weekStart = /^\d{4}-\d{2}-\d{2}$/.test(reqWeek || '') ? reqWeek : thisMonday
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  // Pull the whole week in a few queries, then group in JS.
  const weekStartUnix = Math.floor(localToUtcMs(days[0], '00:00', tz) / 1000)
  const weekEndUnix = Math.floor(localToUtcMs(addDays(days[6], 1), '00:00', tz) / 1000)
  const bookings = (await db.prepare(
    `SELECT * FROM bookings WHERE shop_id = ? AND start_time >= ? AND start_time < ? AND status != 'cancelled' ORDER BY start_time`
  ).bind(shop.id, weekStartUnix, weekEndUnix).all()).results || []

  const avail = (await db.prepare(
    `SELECT s.id, s.name, s.emoji, a.day_of_week, a.start_time, a.end_time
     FROM staff s JOIN availability a ON a.staff_id = s.id
     WHERE s.shop_id = ? AND s.is_active = 1`).bind(shop.id).all()).results || []

  const offs = (await db.prepare(
    `SELECT t.staff_id, t.date, s.name, s.emoji FROM time_off t JOIN staff s ON s.id = t.staff_id
     WHERE s.shop_id = ? AND t.date >= ? AND t.date <= ?`).bind(shop.id, days[0], days[6]).all()).results || []

  // Group helpers
  const availByDow = {}
  for (const a of avail) (availByDow[a.day_of_week] ||= []).push(a)
  const offByDate = {}
  for (const o of offs) (offByDate[o.date] ||= []).push(o)
  const bookByDate = {}
  for (const b of bookings) (bookByDate[dateTzString(new Date(b.start_time * 1000), tz)] ||= []).push(b)

  const cols = days.map(ds => {
    const dow = new Date(ds + 'T12:00:00Z').getUTCDay()
    const offIds = new Set((offByDate[ds] || []).map(o => o.staff_id))
    const working = (availByDow[dow] || []).filter(a => !offIds.has(a.id)).sort((a, b) => a.start_time.localeCompare(b.start_time))
    const offList = offByDate[ds] || []
    const dayBk = bookByDate[ds] || []
    const dnum = new Date(ds + 'T12:00:00Z').getUTCDate()

    // Working chips link to "add a booking" prefilled with that day + therapist.
    const workHtml = working.map(w =>
      `<a class="wchip" href="/dashboard/bookings/new?date=${ds}&staff=${w.id}" title="Add a booking for ${esc(w.name)}"><span>${esc(w.emoji)}</span> ${esc(w.name.split(' ')[0])} <span class="whrs">${w.start_time}–${w.end_time}</span></a>`).join('')
      + offList.map(o => `<div class="wchip off">🌴 ${esc(o.name.split(' ')[0])}</div>`).join('')
    // Each booking block links to its edit/reschedule page.
    const bkHtml = dayBk.map(b =>
      `<a class="bk ${b.status}" href="/dashboard/bookings/${b.id}/edit"><strong>${timeOnly(b.start_time, tz)}</strong> ${esc(b.service_name || '')}
        <div class="bkmeta">${esc(b.customer_name)} · ${esc(b.staff_name || '')}</div></a>`).join('')

    return `<div class="rcol${ds === today ? ' today' : ''}">
      <div class="rhead">${DOW[dow]} <span>${dnum}</span></div>
      <div class="rwork">${workHtml || '<div class="rnone">Closed</div>'}</div>
      <div class="rbook">${bkHtml || '<div class="rnone">No bookings</div>'}<a class="raddday" href="/dashboard/bookings/new?date=${ds}">＋ Add booking</a></div>
    </div>`
  }).join('')

  const label = `${niceOff(days[0])} – ${niceOff(days[6])}`
  const nav = `<div class="inline" style="gap:8px">
    <a class="btn ghost sm" href="/dashboard/roster?week=${addDays(weekStart, -7)}">← Prev</a>
    <a class="btn ghost sm" href="/dashboard/roster">This week</a>
    <a class="btn ghost sm" href="/dashboard/roster?week=${addDays(weekStart, 7)}">Next →</a>
  </div>`

  return shell(c, 'roster', 'Roster', `
    <style>
    .rgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;overflow-x:auto;padding-bottom:6px}
    .rcol{border:1px solid var(--line);border-radius:12px;min-width:150px;background:#fff;display:flex;flex-direction:column;overflow:hidden}
    .rcol.today{border-color:var(--accent);box-shadow:0 0 0 2px rgba(15,118,110,.14)}
    .rhead{padding:8px 10px;border-bottom:1px solid var(--line);font-weight:600;font-size:.82rem;display:flex;justify-content:space-between;align-items:baseline;color:var(--muted)}
    .rcol.today .rhead{color:var(--accent-ink)}
    .rhead span{font-family:'Fraunces',serif;font-size:1.15rem;color:var(--ink)}
    .rwork{padding:8px 10px;border-bottom:1px dashed var(--line);display:flex;flex-direction:column;gap:4px;background:#fcfbf9}
    .rcol a{text-decoration:none;color:inherit;display:block}
    .wchip{font-size:.76rem;background:#eef4f3;border-radius:8px;padding:3px 8px;color:var(--accent-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
    .wchip:hover{background:#dcebe8}
    .wchip.off{background:#faf1e6;color:#8a6414;cursor:default}
    .whrs{color:var(--muted)}
    .rbook{padding:8px 10px;display:flex;flex-direction:column;gap:6px;flex:1;min-height:60px}
    .bk{font-size:.77rem;border-radius:8px;padding:5px 8px;border-left:3px solid var(--accent);background:#f5f8f8;line-height:1.3;cursor:pointer}
    .bk:hover{filter:brightness(.97)}
    .raddday{margin-top:auto;text-align:center;color:var(--muted);font-size:.74rem;padding:6px 0 2px;border-top:1px dashed var(--line)}
    .raddday:hover{color:var(--accent)}
    .bk.pending_payment{border-left-color:#c9a227;background:#fdf7e8}
    .bk.completed{border-left-color:#2f8a5b;background:#eef6f0}
    .bk.no_show{border-left-color:#c0492f;background:#fbeae5;opacity:.75}
    .bkmeta{color:var(--muted);font-size:.7rem}
    .rnone{color:var(--muted);font-size:.74rem;padding:2px 0}
    </style>
    <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div><h2 style="margin:0">Roster</h2><div class="muted">${label} · ${bookings.length} booking${bookings.length === 1 ? '' : 's'}</div></div>
      <div class="inline" style="gap:8px;flex-wrap:wrap"><a class="btn sm" href="/dashboard/bookings/new?date=${weekStart}">➕ Add booking</a>${nav}</div>
    </div>
    <p class="muted" style="font-size:.82rem;margin:10px 0 14px">Green blocks are confirmed bookings, amber are awaiting deposit. 🌴 marks a therapist’s day off. Therapists set their own hours &amp; days off from their <a href="/dashboard/staff">private link</a>.</p>
    <div class="rgrid">${cols}</div>
  `)
})

// ─── Bookings ────────────────────────────────────────────────────────────────
app.get('/bookings', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const filter = c.req.query('f') || 'upcoming'
  const where = {
    upcoming: `AND ${upcomingWhere}`,
    past: `AND (start_time <= unixepoch() OR status IN ('completed','no_show'))`,
    all: ''
  }[filter] ?? ''
  const order = filter === 'past' ? 'DESC' : 'ASC'
  const rows = (await db.prepare(
    `SELECT * FROM bookings WHERE shop_id = ? ${where} ORDER BY start_time ${order} LIMIT 200`).bind(shop.id).all()).results || []

  const tabs = ['upcoming', 'past', 'all'].map(f =>
    `<a href="/dashboard/bookings?f=${f}" class="btn ${filter === f ? '' : 'ghost'} sm">${f[0].toUpperCase() + f.slice(1)}</a>`).join(' ')

  return shell(c, 'bookings', 'Bookings', `
    <div class="inline" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h2>Bookings</h2><div class="inline" style="gap:8px"><a class="btn sm" href="/dashboard/bookings/new">➕ Add booking</a>${tabs}</div></div>
    ${rows.length ? `<div class="card" style="padding:6px 18px"><table>
      <tr><th>When</th><th>Client</th><th>Service</th><th>Therapist</th><th>Deposit</th><th>Status</th><th></th></tr>
      ${rows.map(b => `<tr>
        <td>${formatBookingTime(b.start_time, shop.timezone)}</td>
        <td>${esc(b.customer_name)}<div class="muted" style="font-size:.8rem">${esc(b.customer_email)}${b.customer_phone ? ' · ' + esc(b.customer_phone) : ''}</div>${b.notes ? `<div class="muted" style="font-size:.8rem">📝 ${esc(b.notes)}</div>` : ''}</td>
        <td>${esc(b.service_name)}</td>
        <td>${esc(b.staff_name || '')}</td>
        <td>${b.deposit_cents ? money(b.deposit_cents, shop.currency) : '—'}${b.refunded_at ? '<div class="muted" style="font-size:.75rem">refunded</div>' : ''}</td>
        <td><span class="tag ${b.status}">${b.status.replace('_', ' ')}</span></td>
        <td><div class="inline">
          ${['confirmed', 'pending_payment'].includes(b.status) ? `
            <a class="btn ghost sm" href="/dashboard/bookings/${b.id}/edit">Edit</a>
            <form method="post" action="/dashboard/bookings/${b.id}/complete"><button class="btn sm">✓ Done</button></form>
            <form method="post" action="/dashboard/bookings/${b.id}/no_show"><button class="btn ghost sm">No-show</button></form>
            <form method="post" action="/dashboard/bookings/${b.id}/cancel" onsubmit="return confirm('Cancel${b.deposit_cents && b.stripe_charge_id ? ' and refund the deposit' : ''}?')"><button class="btn danger sm">Cancel</button></form>
          ` : ''}
        </div></td>
      </tr>`).join('')}
    </table></div>` : '<p class="muted">Nothing here yet.</p>'}
  `)
})

async function bookingAction(c, action) {
  const db = c.env.DB, shop = c.get('shop')
  const id = c.req.param('id')
  const b = await db.prepare('SELECT * FROM bookings WHERE id = ? AND shop_id = ?').bind(id, shop.id).first()
  if (!b) return c.redirect('/dashboard/bookings')

  if (action === 'complete') await db.prepare("UPDATE bookings SET status='completed' WHERE id=?").bind(id).run()
  if (action === 'no_show') await db.prepare("UPDATE bookings SET status='no_show' WHERE id=?").bind(id).run()
  if (action === 'cancel') {
    if (b.deposit_cents && b.stripe_charge_id && !b.refunded_at && c.env.STRIPE_SECRET_KEY) {
      try {
        await stripeClient(c.env.STRIPE_SECRET_KEY).createRefund({ charge: b.stripe_charge_id, reason: 'requested_by_customer' })
        await db.prepare("UPDATE bookings SET refunded_at = unixepoch() WHERE id=?").bind(id).run()
      } catch (e) { console.error('refund failed:', e.message) }
    }
    await db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").bind(id).run()
    // Tell the customer (localized), noting the refund if one was issued. Non-blocking.
    const emailP = sendCancellationEmail(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(emailP); else await emailP
  }
  return c.redirect('/dashboard/bookings')
}
app.post('/bookings/:id/complete', c => bookingAction(c, 'complete'))
app.post('/bookings/:id/no_show', c => bookingAction(c, 'no_show'))
app.post('/bookings/:id/cancel', c => bookingAction(c, 'cancel'))

// ─── Manually add / edit a booking (any custom time, e.g. 9:10am–10:25am) ────
// 24h HH:MM in a timezone, for prefilling <input type="time">
const hm = (unix, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(unix * 1000))
const rosterWeekOf = (date) => { const dow = new Date(date + 'T12:00:00Z').getUTCDay(); return addDays(date, dow === 0 ? -6 : 1 - dow) }
const clientsForShop = (db, shopId) => db.prepare('SELECT id,name,email,phone,notes FROM clients WHERE shop_id=? ORDER BY name COLLATE NOCASE LIMIT 1000').bind(shopId).all().then(r => r.results || [])

// Shared create/edit form. `v` holds prefilled values, `action` the POST target.
function bookingForm(shop, staff, services, clients, action, submitLabel, v = {}) {
  return `
    <form method="post" action="${action}" class="card" style="padding:22px;max-width:580px">
      <div class="row">
        <div class="field"><label>Date</label><input type="date" name="date" value="${v.date || ''}" required></div>
        <div class="field"><label>Therapist</label><select name="staff_id" required>${staff.map(s => `<option value="${s.id}" ${v.staff_id === s.id ? 'selected' : ''}>${esc(s.emoji)} ${esc(s.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Service</label>
        <select name="service_id" id="svc">
          <option value="">Custom / other</option>
          ${services.map(s => `<option value="${s.id}" data-dur="${s.duration_minutes}" data-price="${s.price_cents}" ${v.service_id === s.id ? 'selected' : ''}>${esc(s.name)} · ${s.duration_minutes} min</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <div class="field"><label>Start time</label><input type="time" name="start" id="st" step="300" value="${v.start || '09:00'}" required></div>
        <div class="field"><label>End time</label><input type="time" name="end" id="et" step="300" value="${v.end || '10:00'}" required></div>
      </div>
      <div class="row">
        <div class="field"><label>Custom label <span class="muted">(optional)</span></label><input name="custom_name" value="${esc(v.custom_name || '')}" placeholder="e.g. Extended session"></div>
        <div class="field" style="flex:0 0 150px"><label>Price (${shop.currency.toUpperCase()})</label><input type="number" name="price" id="pr" min="0" step="1" value="${v.price != null ? v.price : ''}"></div>
      </div>

      <div class="field"><label>Client</label>
        <select id="clientsel">
          <option value="">➕ New client / walk-in</option>
          ${clients.map(cl => `<option value="${cl.id}" data-name="${esc(cl.name)}" data-email="${esc(cl.email || '')}" data-phone="${esc(cl.phone || '')}" data-notes="${esc(cl.notes || '')}" ${v.client_id === cl.id ? 'selected' : ''}>${esc(cl.name)}${cl.phone ? ` · ${esc(cl.phone)}` : ''}${cl.email ? ` · ${esc(cl.email)}` : ''}</option>`).join('')}
        </select>
        <p class="muted" style="font-size:.78rem;margin:4px 0 0">Pick a saved client to auto-fill their details, or leave as “New client”.</p>
      </div>
      <input type="hidden" name="client_id" id="client_id" value="${v.client_id || ''}">
      <div id="clientnotes" class="notice" style="display:none;background:#fdf7e8;color:#8a6414;white-space:pre-wrap"></div>

      <div class="row">
        <div class="field"><label>Customer name</label><input name="customer_name" id="cn" value="${esc(v.customer_name || '')}" placeholder="Walk-in"></div>
        <div class="field"><label>Phone <span class="muted">(optional)</span></label><input name="customer_phone" id="cp" value="${esc(v.customer_phone || '')}"></div>
      </div>
      <div class="field"><label>Customer email <span class="muted">(optional — emails a confirmation/update)</span></label><input type="email" name="customer_email" id="ce" value="${esc(v.customer_email || '')}"></div>
      <div class="field"><label>Appointment notes <span class="muted">(this booking only)</span></label><input name="notes" value="${esc(v.notes || '')}" placeholder="Injuries, preferences…"></div>
      <button class="btn">${submitLabel}</button>
    </form>
    <script>
    // Picking a service auto-fills the end time (start + duration) and price,
    // but both stay fully editable — that's the point of custom bookings.
    const svc=document.getElementById('svc'),st=document.getElementById('st'),et=document.getElementById('et'),pr=document.getElementById('pr');
    function fillEnd(){const o=svc.selectedOptions[0],d=o&&o.dataset.dur?+o.dataset.dur:0;if(!d||!st.value)return;const p=st.value.split(':').map(Number);let t=Math.min(p[0]*60+p[1]+d,23*60+55);et.value=String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');}
    svc.addEventListener('change',()=>{fillEnd();const o=svc.selectedOptions[0];if(o&&o.dataset.price&&!pr.value)pr.value=(+o.dataset.price/100).toFixed(0);});
    st.addEventListener('change',fillEnd);
    // Client picker: fill contact + show the client's saved notes.
    const cs=document.getElementById('clientsel'),cid=document.getElementById('client_id'),cnb=document.getElementById('clientnotes'),cn=document.getElementById('cn'),ce=document.getElementById('ce'),cp=document.getElementById('cp');
    function showNotes(o){if(o&&o.value&&o.dataset.notes){cnb.textContent='📋 '+o.dataset.notes;cnb.style.display='block';}else{cnb.style.display='none';}}
    cs.addEventListener('change',()=>{const o=cs.selectedOptions[0];cid.value=o.value;if(o.value){cn.value=o.dataset.name||'';ce.value=o.dataset.email||'';cp.value=o.dataset.phone||'';}showNotes(o);});
    showNotes(cs.selectedOptions[0]);
    </script>`
}

// Parse + validate the shared booking form. Returns { error } or the resolved fields.
async function resolveBookingInput(c, shop) {
  const db = c.env.DB, f = await c.req.parseBody()
  const date = (f.date || '').toString(), startT = (f.start || '').toString(), endT = (f.end || '').toString()
  const staffId = (f.staff_id || '').toString()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(startT) || !/^\d{1,2}:\d{2}$/.test(endT) || !staffId) return { error: true, date }
  const staff = await db.prepare('SELECT id,name FROM staff WHERE id=? AND shop_id=?').bind(staffId, shop.id).first()
  if (!staff) return { error: true, date }
  const startUnix = Math.floor(localToUtcMs(date, startT, shop.timezone) / 1000)
  const endUnix = Math.floor(localToUtcMs(date, endT, shop.timezone) / 1000)
  if (endUnix <= startUnix) return { error: true, date }

  // service_id is a NOT NULL foreign key D1 enforces, so anchor to a real row.
  const customName = (f.custom_name || '').toString().trim()
  let sv = f.service_id ? await db.prepare('SELECT id,name,price_cents FROM services WHERE id=? AND shop_id=?').bind(f.service_id.toString(), shop.id).first() : null
  const explicit = !!sv
  if (!sv) sv = await db.prepare('SELECT id,name,price_cents FROM services WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at LIMIT 1').bind(shop.id).first()
  if (!sv) return { error: true, date }
  const priceStr = (f.price || '').toString().trim()
  const priceCents = priceStr !== '' ? Math.max(0, Math.round(parseFloat(priceStr) * 100) || 0) : (explicit ? sv.price_cents : 0)

  const customerName = (f.customer_name || '').toString().trim() || 'Walk-in'
  const email = (f.customer_email || '').toString().trim().toLowerCase()
  const phone = (f.customer_phone || '').toString().trim()
  // Link to a saved client: the one picked (keep its contact fresh) or find/create by contact.
  let clientId = (f.client_id || '').toString() || null
  if (clientId) {
    const cl = await db.prepare('SELECT id FROM clients WHERE id=? AND shop_id=?').bind(clientId, shop.id).first()
    if (cl) await db.prepare('UPDATE clients SET name=?, email=?, phone=?, updated_at=unixepoch() WHERE id=?').bind(customerName, email || null, phone || null, clientId).run()
    else clientId = null
  }
  if (!clientId) clientId = await findOrCreateClient(db, shop.id, { name: customerName, email, phone })

  return {
    date, staff, startUnix, endUnix, serviceId: sv.id, serviceName: customName || sv.name, priceCents,
    customerName, email, phone, clientId, notes: (f.notes || '').toString(),
  }
}

app.get('/bookings/new', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('date') || '') ? c.req.query('date') : dateTzString(new Date(), shop.timezone)
  const staff = (await db.prepare('SELECT id,name,emoji FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const services = (await db.prepare('SELECT id,name,duration_minutes,price_cents FROM services WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  if (!staff.length) return shell(c, 'bookings', 'Add booking', `<h2>Add a booking</h2><p class="muted">Add a <a href="/dashboard/staff">therapist</a> first.</p>`)
  if (!services.length) return shell(c, 'bookings', 'Add booking', `<h2>Add a booking</h2><p class="muted">Add a <a href="/dashboard/services">service</a> first — bookings attach to one (you can still set any custom time and label).</p>`)

  const clients = await clientsForShop(db, shop.id)
  const v = { date, staff_id: c.req.query('staff') || staff[0].id, client_id: c.req.query('client') || '' }
  return shell(c, 'bookings', 'Add booking', `
    <a href="/dashboard/roster" class="muted">← Back to roster</a>
    <h2>Add a booking</h2>
    <p class="muted" style="margin-top:-6px">Manually schedule an appointment at any time — pick a start and end, e.g. <strong>9:10 am</strong> to <strong>10:25 am</strong>.</p>
    ${bookingForm(shop, staff, services, clients, '/dashboard/bookings/new', 'Add booking', v)}
  `)
})

app.post('/bookings/new', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const r = await resolveBookingInput(c, shop)
  if (r.error) return c.redirect(`/dashboard/bookings/new${r.date ? `?date=${r.date}` : ''}`)

  const id = genId()
  await db.prepare(`INSERT INTO bookings
    (id, shop_id, service_id, staff_id, customer_name, customer_email, customer_phone,
     start_time, end_time, status, price_cents, deposit_cents, service_name, staff_name, notes, lang, client_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 0, ?, ?, ?, 'en', ?)`)
    .bind(id, shop.id, r.serviceId, r.staff.id, r.customerName, r.email, r.phone,
      r.startUnix, r.endUnix, r.priceCents, r.serviceName, r.staff.name, r.notes, r.clientId).run()

  if (r.email) {
    const p = sendBookingEmails(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
  }
  return c.redirect(`/dashboard/roster?week=${rosterWeekOf(r.date)}`)
})

app.get('/bookings/:id/edit', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(c.req.param('id'), shop.id).first()
  if (!b) return c.redirect('/dashboard/bookings')
  const staff = (await db.prepare('SELECT id,name,emoji FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const services = (await db.prepare('SELECT id,name,duration_minutes,price_cents FROM services WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const clients = await clientsForShop(db, shop.id)
  const v = {
    date: dateTzString(new Date(b.start_time * 1000), shop.timezone),
    start: hm(b.start_time, shop.timezone), end: hm(b.end_time, shop.timezone),
    staff_id: b.staff_id, service_id: b.service_id, custom_name: b.service_name,
    price: b.price_cents ? b.price_cents / 100 : 0, client_id: b.client_id || '',
    customer_name: b.customer_name, customer_email: b.customer_email, customer_phone: b.customer_phone, notes: b.notes,
  }
  return shell(c, 'bookings', 'Edit booking', `
    <a href="/dashboard/bookings" class="muted">← Back to bookings</a>
    <h2>Edit / reschedule booking</h2>
    <p class="muted" style="margin-top:-6px">Change the time, therapist or details. <span class="tag ${b.status}">${b.status.replace('_', ' ')}</span></p>
    ${bookingForm(shop, staff, services, clients, `/dashboard/bookings/${b.id}/edit`, 'Save changes', v)}
  `)
})

app.post('/bookings/:id/edit', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), id = c.req.param('id')
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(id, shop.id).first()
  if (!b) return c.redirect('/dashboard/bookings')
  const r = await resolveBookingInput(c, shop)
  if (r.error) return c.redirect(`/dashboard/bookings/${id}/edit`)

  await db.prepare(`UPDATE bookings SET service_id=?, staff_id=?, customer_name=?, customer_email=?, customer_phone=?,
    start_time=?, end_time=?, price_cents=?, service_name=?, staff_name=?, notes=?, client_id=? WHERE id=?`)
    .bind(r.serviceId, r.staff.id, r.customerName, r.email, r.phone,
      r.startUnix, r.endUnix, r.priceCents, r.serviceName, r.staff.name, r.notes, r.clientId, id).run()

  // If it was moved to a new time, email the customer that it was rescheduled.
  if (r.email && r.startUnix !== b.start_time) {
    const p = sendRescheduleEmail(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
  }
  return c.redirect(`/dashboard/roster?week=${rosterWeekOf(r.date)}`)
})

// ─── Services ────────────────────────────────────────────────────────────────
app.get('/services', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const rows = (await db.prepare('SELECT * FROM services WHERE shop_id = ? ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  return shell(c, 'services', 'Services', `
    <h2>Services</h2>
    <div class="card" style="padding:6px 18px;margin-bottom:20px">
      ${rows.length ? `<table><tr><th>Name</th><th>Duration</th><th>Price</th><th>Deposit*</th><th></th></tr>
      ${rows.map(s => `<tr>
        <td><strong>${esc(s.name)}</strong>${s.is_active ? '' : ' <span class="muted">(hidden)</span>'}${s.description ? `<div class="muted" style="font-size:.8rem">${esc(s.description)}</div>` : ''}</td>
        <td>${s.duration_minutes} min</td><td>${money(s.price_cents, shop.currency)}</td>
        <td>${money(Math.round(s.price_cents * shop.deposit_pct / 100), shop.currency)}</td>
        <td><form method="post" action="/dashboard/services/${s.id}/delete" onsubmit="return confirm('Delete this service?')"><button class="btn danger sm">Delete</button></form></td>
      </tr>`).join('')}</table>` : '<p class="muted" style="padding:12px 0">No services yet.</p>'}
    </div>
    <p class="muted" style="font-size:.8rem">*Deposit is ${shop.deposit_pct}% of the price (change it in <a href="/dashboard/settings">Settings</a>).</p>
    <div class="card" style="padding:22px">
      <h3 style="margin-top:0">Add a service</h3>
      <form method="post" action="/dashboard/services">
        <div class="field"><label>Name</label><input name="name" required placeholder="60min Deep Tissue Massage"></div>
        <div class="field"><label>Description</label><input name="description" placeholder="Firm pressure to release deep muscle tension"></div>
        <div class="row">
          <div class="field"><label>Duration (minutes)</label><input type="number" name="duration" value="60" min="10" step="5" required></div>
          <div class="field"><label>Price (${shop.currency.toUpperCase()})</label><input type="number" name="price" value="120" min="0" step="1" required></div>
        </div>
        <button class="btn">Add service</button>
      </form>
    </div>
  `)
})

app.post('/services', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const f = await c.req.parseBody()
  await db.prepare(`INSERT INTO services (id, shop_id, name, description, duration_minutes, price_cents, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(genId(), shop.id, (f.name || '').toString().trim(), (f.description || '').toString().trim(),
      parseInt(f.duration) || 60, Math.round((parseFloat(f.price) || 0) * 100),
      Math.floor(Date.now() / 1000)).run()
  return c.redirect('/dashboard/services')
})

app.post('/services/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM services WHERE id = ? AND shop_id = ?').bind(c.req.param('id'), c.get('shop').id).run()
  return c.redirect('/dashboard/services')
})

// ─── Staff + hours ───────────────────────────────────────────────────────────
app.get('/staff', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
  const today = dateTzString(new Date(), shop.timezone)
  const staff = (await db.prepare('SELECT * FROM staff WHERE shop_id = ? ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const hoursFor = async (id) => (await db.prepare('SELECT * FROM availability WHERE staff_id = ? ORDER BY day_of_week').bind(id).all()).results || []
  const offFor = async (id) => (await db.prepare('SELECT * FROM time_off WHERE staff_id = ? AND date >= ? ORDER BY date').bind(id, today).all()).results || []

  const cards = []
  for (const st of staff) {
    const hours = await hoursFor(st.id)
    const hByDow = Object.fromEntries(hours.map(h => [h.day_of_week, h]))
    const off = await offFor(st.id)
    const link = `${base}/t/${st.token}`
    cards.push(`<div class="card" style="padding:20px;margin-bottom:16px">
      <div class="inline" style="justify-content:space-between">
        <div><span style="font-size:1.4rem">${esc(st.emoji)}</span> <strong>${esc(st.name)}</strong> <span class="muted">${esc(st.title || '')}</span></div>
        <form method="post" action="/dashboard/staff/${st.id}/delete" onsubmit="return confirm('Remove this therapist?')"><button class="btn danger sm">Remove</button></form>
      </div>

      <div class="card" style="padding:12px 14px;background:#f6f2ec;border-style:dashed;margin-top:14px">
        <label style="margin-bottom:4px">🔗 ${esc(st.name.split(' ')[0])}’s private scheduling link</label>
        <div class="inline">
          <input value="${esc(link)}" readonly style="max-width:360px" id="tl_${st.id}">
          <button class="btn ghost sm" type="button" onclick="navigator.clipboard.writeText(document.getElementById('tl_${st.id}').value);this.textContent='Copied ✓'">Copy</button>
          <a class="btn ghost sm" href="${esc(link)}" target="_blank">Open</a>
        </div>
        <p class="muted" style="font-size:.78rem;margin:8px 0 0">Send this so they can set their own hours &amp; days off. ${off.length ? `🌴 Days off: <strong>${off.map(o => esc(niceOff(o.date))).join(', ')}</strong>` : 'No days off booked.'}</p>
        <div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
          <label style="margin-bottom:4px">✉️ Login email ${st.therapist_id ? '<span class="tag completed">account linked</span>' : (st.email ? '<span class="tag pending_payment">invited</span>' : '')}</label>
          <form method="post" action="/dashboard/staff/${st.id}/email" class="inline">
            <input type="email" name="email" value="${esc(st.email || '')}" placeholder="therapist@email.com" style="max-width:280px">
            <button class="btn ghost sm">Save</button>
          </form>
          <p class="muted" style="font-size:.76rem;margin:6px 0 0">${st.therapist_id
            ? 'They log in at <a href="/pro" target="_blank">/pro</a> and manage this shop from their own account (works across every shop they’re at).'
            : 'Set their email so they can create a login at <a href="/pro" target="_blank">/pro</a> and manage hours across all their shops.'}</p>
        </div>
      </div>

      <form method="post" action="/dashboard/staff/${st.id}/hours" style="margin-top:14px">
        <label>Weekly hours</label>
        <table style="margin-bottom:12px"><tr><th></th><th>Open</th><th>Start</th><th>End</th></tr>
        ${DOW.map((d, i) => {
          const h = hByDow[i]
          return `<tr><td><strong>${d}</strong></td>
            <td><input type="checkbox" name="on_${i}" ${h ? 'checked' : ''} style="width:auto"></td>
            <td><input type="time" name="start_${i}" step="300" value="${h?.start_time || '09:00'}" style="max-width:130px"></td>
            <td><input type="time" name="end_${i}" step="300" value="${h?.end_time || '18:00'}" style="max-width:130px"></td></tr>`
        }).join('')}</table>
        <button class="btn sm">Save hours</button>
      </form>
    </div>`)
  }

  return shell(c, 'staff', 'Therapists', `
    <h2>Therapists</h2>
    <p class="muted" style="margin-top:-6px">Set hours here, or send each therapist their private link so they manage their own hours &amp; days off.</p>
    ${cards.join('') || '<p class="muted">No therapists yet.</p>'}
    <div class="card" style="padding:22px">
      <h3 style="margin-top:0">Add a therapist</h3>
      <form method="post" action="/dashboard/staff">
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required placeholder="Jordan Lee"></div>
          <div class="field"><label>Title</label><input name="title" value="Massage Therapist"></div>
          <div class="field" style="flex:0 0 90px"><label>Emoji</label><input name="emoji" value="🧑‍⚕️" maxlength="4"></div>
        </div>
        <div class="field"><label>Email <span class="muted">(lets them log in at /pro to manage their own hours — great if they also work elsewhere)</span></label><input type="email" name="email" placeholder="jordan@email.com"></div>
        <button class="btn">Add therapist</button>
      </form>
    </div>
  `)
})

app.post('/staff', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const f = await c.req.parseBody()
  const id = genId()
  const email = (f.email || '').toString().trim().toLowerCase()
  await db.prepare('INSERT INTO staff (id, shop_id, name, title, emoji, token, email, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, shop.id, (f.name || '').toString().trim(), (f.title || 'Massage Therapist').toString().trim(),
      (f.emoji || '🧑‍⚕️').toString().trim() || '🧑‍⚕️', genId() + genId(), email || null, Math.floor(Date.now() / 1000)).run()
  // If a therapist login already exists for this email, link it now so they
  // instantly see this shop under their account.
  if (email) {
    const th = await db.prepare('SELECT id FROM therapists WHERE email = ?').bind(email).first()
    if (th) await db.prepare('UPDATE staff SET therapist_id = ? WHERE id = ?').bind(th.id, id).run()
  }
  // Default Mon–Sat 9–6 so they can be booked right away
  for (let dow = 1; dow <= 6; dow++)
    await db.prepare('INSERT INTO availability (id, staff_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
      .bind(genId(), id, dow, '09:00', '18:00').run()
  return c.redirect('/dashboard/staff')
})

app.post('/staff/:id/delete', async (c) => {
  await c.env.DB.prepare('DELETE FROM staff WHERE id = ? AND shop_id = ?').bind(c.req.param('id'), c.get('shop').id).run()
  return c.redirect('/dashboard/staff')
})

app.post('/staff/:id/email', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), id = c.req.param('id')
  const st = await db.prepare('SELECT id FROM staff WHERE id = ? AND shop_id = ?').bind(id, shop.id).first()
  if (!st) return c.redirect('/dashboard/staff')
  const email = ((await c.req.parseBody()).email || '').toString().trim().toLowerCase()
  // Re-link to a matching therapist account if one exists (else leave unlinked
  // until the therapist signs up with this email).
  const th = email ? await db.prepare('SELECT id FROM therapists WHERE email = ?').bind(email).first() : null
  await db.prepare('UPDATE staff SET email = ?, therapist_id = ? WHERE id = ?').bind(email || null, th?.id || null, id).run()
  return c.redirect('/dashboard/staff')
})

app.post('/staff/:id/hours', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const id = c.req.param('id')
  const st = await db.prepare('SELECT id FROM staff WHERE id = ? AND shop_id = ?').bind(id, shop.id).first()
  if (!st) return c.redirect('/dashboard/staff')
  const f = await c.req.parseBody()
  await db.prepare('DELETE FROM availability WHERE staff_id = ?').bind(id).run()
  for (let i = 0; i < 7; i++) {
    if (!f[`on_${i}`]) continue
    const start = (f[`start_${i}`] || '09:00').toString(), end = (f[`end_${i}`] || '18:00').toString()
    if (end <= start) continue
    await db.prepare('INSERT INTO availability (id, staff_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
      .bind(genId(), id, i, start, end).run()
  }
  return c.redirect('/dashboard/staff')
})

// ─── Settings ────────────────────────────────────────────────────────────────
app.get('/settings', async (c) => {
  const shop = c.get('shop')
  const f = (k, v) => esc(shop[k] ?? v ?? '')
  return shell(c, 'settings', 'Settings', `
    <h2>Shop settings</h2>
    <form method="post" action="/dashboard/settings">
      <div class="card" style="padding:22px;margin-bottom:18px">
        <div class="row">
          <div class="field"><label>Shop name</label><input name="name" value="${f('name')}" required></div>
          <div class="field" style="flex:0 0 90px"><label>Emoji</label><input name="emoji" value="${f('emoji')}" maxlength="4"></div>
        </div>
        <div class="field"><label>Tagline</label><input name="tagline" value="${f('tagline')}"></div>
        <div class="field"><label>About</label><textarea name="about" rows="4">${f('about')}</textarea></div>
        <div class="row">
          <div class="field"><label>Public link slug</label><input name="slug" value="${f('slug')}" required></div>
          <div class="field"><label>Accent colour</label><input type="color" name="accent" value="${f('accent', '#0f766e')}"></div>
        </div>
      </div>
      <div class="card" style="padding:22px;margin-bottom:18px">
        <h3 style="margin-top:0">Contact &amp; location</h3>
        <div class="row"><div class="field"><label>Phone</label><input name="phone" value="${f('phone')}"></div>
          <div class="field"><label>Public email</label><input name="email" value="${f('email')}"></div></div>
        <div class="field"><label>Street address</label><input name="address" value="${f('address')}"></div>
        <div class="row">
          <div class="field"><label>Suburb</label><input name="suburb" value="${f('suburb')}"></div>
          <div class="field"><label>State</label><input name="state" value="${f('state')}"></div>
          <div class="field"><label>Postcode</label><input name="postcode" value="${f('postcode')}"></div>
        </div>
        <div class="field"><label>Timezone</label>
          <select name="timezone">${['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Perth', 'Pacific/Auckland', 'America/New_York', 'America/Los_Angeles', 'Europe/London']
            .map(tz => `<option ${shop.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}</select></div>
      </div>
      <div class="card" style="padding:22px;margin-bottom:18px">
        <h3 style="margin-top:0">Deposits &amp; cancellation</h3>
        <div class="row">
          <div class="field"><label>Deposit (% of price)</label><input type="number" name="deposit_pct" value="${f('deposit_pct', 20)}" min="0" max="100"></div>
          <div class="field"><label>Free cancellation window (hours)</label><input type="number" name="cancellation_hours" value="${f('cancellation_hours', 24)}" min="0"></div>
          <div class="field"><label>Booking time interval</label>
            <select name="slot_interval_minutes">${[5, 10, 15, 20, 30, 60].map(m => `<option value="${m}" ${Number(shop.slot_interval_minutes || 15) === m ? 'selected' : ''}>Every ${m} minutes</option>`).join('')}</select></div>
        </div>
        <p class="muted" style="font-size:.82rem;margin:0">Set deposit to 0% to take bookings with no upfront payment. <strong>Booking time interval</strong> controls how far apart the offered start times are — choose 5 minutes for the finest control.</p>
      </div>
      <button class="btn">Save settings</button>
    </form>
  `)
})

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

app.post('/settings', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const f = await c.req.parseBody()
  let slug = slugify((f.slug || shop.slug).toString()) || shop.slug
  // keep slug unique (ignore our own row)
  const clash = await db.prepare('SELECT id FROM shops WHERE slug = ? AND id != ?').bind(slug, shop.id).first()
  if (clash) slug = `${slug}-${shop.id.slice(0, 4)}`

  const interval = [5, 10, 15, 20, 30, 60].includes(parseInt(f.slot_interval_minutes)) ? parseInt(f.slot_interval_minutes) : 15
  await db.prepare(`UPDATE shops SET name=?, emoji=?, tagline=?, about=?, slug=?, accent=?, phone=?, email=?,
    address=?, suburb=?, state=?, postcode=?, timezone=?, deposit_pct=?, cancellation_hours=?, slot_interval_minutes=? WHERE id=?`)
    .bind((f.name || shop.name).toString().trim(), (f.emoji || '💆').toString().trim() || '💆',
      (f.tagline || '').toString(), (f.about || '').toString(), slug, (f.accent || '#0f766e').toString(),
      (f.phone || '').toString(), (f.email || '').toString(), (f.address || '').toString(),
      (f.suburb || '').toString(), (f.state || '').toString(), (f.postcode || '').toString(),
      (f.timezone || shop.timezone).toString(), parseInt(f.deposit_pct) || 0, parseInt(f.cancellation_hours) || 0, interval, shop.id).run()
  return c.redirect('/dashboard/settings')
})

// ─── Clients (saved customers + notes) ───────────────────────────────────────
// A booking counts toward a client via client_id OR a matching email (so history
// from before this client row existed still shows up).
const clientMatch = `(b.client_id = cl.id OR (cl.email IS NOT NULL AND cl.email <> '' AND lower(b.customer_email) = lower(cl.email)))`

app.get('/clients', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const q = (c.req.query('q') || '').trim()
  const cols = `cl.*,
    (SELECT COUNT(*) FROM bookings b WHERE b.shop_id = cl.shop_id AND ${clientMatch} AND b.status IN ('confirmed','completed')) AS visits,
    (SELECT MAX(start_time) FROM bookings b WHERE b.shop_id = cl.shop_id AND ${clientMatch}) AS last_visit`
  let rows
  if (q) {
    const like = `%${q.toLowerCase()}%`
    rows = (await db.prepare(`SELECT ${cols} FROM clients cl WHERE cl.shop_id = ?
      AND (lower(cl.name) LIKE ? OR lower(cl.email) LIKE ? OR cl.phone LIKE ?)
      ORDER BY cl.name COLLATE NOCASE LIMIT 300`).bind(shop.id, like, like, `%${q}%`).all()).results || []
  } else {
    rows = (await db.prepare(`SELECT ${cols} FROM clients cl WHERE cl.shop_id = ? ORDER BY cl.updated_at DESC LIMIT 300`).bind(shop.id).all()).results || []
  }
  const total = (await db.prepare('SELECT COUNT(*) n FROM clients WHERE shop_id = ?').bind(shop.id).first())?.n || 0

  return shell(c, 'clients', 'Clients', `
    <div class="inline" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <h2 style="margin:0">Clients <span class="muted" style="font-size:1rem">(${total})</span></h2>
      <form method="get" action="/dashboard/clients" class="inline" style="gap:6px">
        <input name="q" value="${esc(q)}" placeholder="Search name, phone or email…" style="max-width:260px">
        <button class="btn ghost sm">Search</button>
        ${q ? `<a class="btn ghost sm" href="/dashboard/clients">Clear</a>` : ''}
      </form>
    </div>
    ${rows.length ? `<div class="card" style="padding:6px 18px;margin-top:14px"><table>
      <tr><th>Name</th><th>Phone</th><th>Email</th><th>Visits</th><th>Last visit</th><th>Notes</th></tr>
      ${rows.map(cl => `<tr>
        <td><a href="/dashboard/clients/${cl.id}"><strong>${esc(cl.name)}</strong></a></td>
        <td>${esc(cl.phone || '—')}</td>
        <td>${esc(cl.email || '—')}</td>
        <td>${cl.visits}</td>
        <td>${cl.last_visit ? esc(formatBookingTime(cl.last_visit, shop.timezone)) : '—'}</td>
        <td class="muted" style="max-width:220px">${cl.notes ? esc(cl.notes.length > 60 ? cl.notes.slice(0, 60) + '…' : cl.notes) : ''}</td>
      </tr>`).join('')}
    </table></div>` : `<p class="muted" style="margin-top:14px">${q ? 'No clients match that search.' : 'No clients yet — they’re saved automatically when a booking is made.'}</p>`}

    <div class="card" style="padding:22px;margin-top:20px;max-width:560px">
      <h3 style="margin-top:0">Add a client</h3>
      <form method="post" action="/dashboard/clients/new">
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required></div>
          <div class="field"><label>Phone</label><input name="phone"></div>
        </div>
        <div class="field"><label>Email</label><input type="email" name="email"></div>
        <div class="field"><label>Notes <span class="muted">(insurance, preferences, flags…)</span></label><textarea name="notes" rows="2" placeholder="e.g. Medibank member · prefers firm pressure"></textarea></div>
        <button class="btn">Add client</button>
      </form>
    </div>
  `)
})

app.get('/clients/:id', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const cl = await db.prepare('SELECT * FROM clients WHERE id=? AND shop_id=?').bind(c.req.param('id'), shop.id).first()
  if (!cl) return c.redirect('/dashboard/clients')
  const saved = c.req.query('saved')
  const history = (await db.prepare(
    `SELECT * FROM bookings b WHERE b.shop_id=? AND (b.client_id=? OR (? <> '' AND lower(b.customer_email)=lower(?))) ORDER BY start_time DESC LIMIT 100`
  ).bind(shop.id, cl.id, cl.email || '', cl.email || '').all()).results || []

  return shell(c, 'clients', cl.name, `
    <a href="/dashboard/clients" class="muted">← All clients</a>
    <div class="inline" style="justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:6px">
      <h2 style="margin:0">${esc(cl.name)}</h2>
      <div class="inline" style="gap:8px">
        <a class="btn sm" href="/dashboard/bookings/new?client=${cl.id}">➕ Book again</a>
        <form method="post" action="/dashboard/clients/${cl.id}/delete" onsubmit="return confirm('Delete this client? Their bookings stay, just unlinked.')"><button class="btn danger sm">Delete</button></form>
      </div>
    </div>
    ${saved ? `<div class="notice ok" style="margin-top:12px">Saved ✓</div>` : ''}
    <div class="grid g2" style="margin-top:14px;align-items:start">
      <form method="post" action="/dashboard/clients/${cl.id}" class="card" style="padding:22px">
        <h3 style="margin-top:0">Details</h3>
        <div class="field"><label>Name</label><input name="name" value="${esc(cl.name)}" required></div>
        <div class="row">
          <div class="field"><label>Phone</label><input name="phone" value="${esc(cl.phone || '')}"></div>
          <div class="field"><label>Email</label><input type="email" name="email" value="${esc(cl.email || '')}"></div>
        </div>
        <div class="field"><label>📋 Notes <span class="muted">(kept on the client — insurance, preferences, flags)</span></label>
          <textarea name="notes" rows="6" placeholder="e.g. Medibank member. Prefers firm pressure. Was rude on last visit — take deposit.">${esc(cl.notes || '')}</textarea></div>
        <button class="btn">Save</button>
      </form>
      <div>
        <h3>Booking history</h3>
        ${history.length ? `<div class="card" style="padding:6px 18px"><table>
          <tr><th>When</th><th>Service</th><th>Therapist</th><th>Status</th></tr>
          ${history.map(b => `<tr><td>${esc(formatBookingTime(b.start_time, shop.timezone))}</td><td>${esc(b.service_name || '')}</td><td>${esc(b.staff_name || '')}</td><td><span class="tag ${b.status}">${b.status.replace('_', ' ')}</span></td></tr>`).join('')}
        </table></div>` : '<p class="muted">No bookings yet.</p>'}
      </div>
    </div>
  `)
})

app.post('/clients/new', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const f = await c.req.parseBody()
  const name = (f.name || '').toString().trim()
  if (!name) return c.redirect('/dashboard/clients')
  const id = genId()
  await db.prepare('INSERT INTO clients (id, shop_id, name, email, phone, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, shop.id, name, (f.email || '').toString().trim().toLowerCase() || null, (f.phone || '').toString().trim() || null, (f.notes || '').toString().trim() || null).run()
  return c.redirect(`/dashboard/clients/${id}`)
})

app.post('/clients/:id', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), id = c.req.param('id')
  const cl = await db.prepare('SELECT id FROM clients WHERE id=? AND shop_id=?').bind(id, shop.id).first()
  if (!cl) return c.redirect('/dashboard/clients')
  const f = await c.req.parseBody()
  await db.prepare('UPDATE clients SET name=?, email=?, phone=?, notes=?, updated_at=unixepoch() WHERE id=?')
    .bind((f.name || 'Client').toString().trim() || 'Client', (f.email || '').toString().trim().toLowerCase() || null,
      (f.phone || '').toString().trim() || null, (f.notes || '').toString().trim() || null, id).run()
  return c.redirect(`/dashboard/clients/${id}?saved=1`)
})

app.post('/clients/:id/delete', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), id = c.req.param('id')
  await db.prepare('UPDATE bookings SET client_id=NULL WHERE client_id=? AND shop_id=?').bind(id, shop.id).run()
  await db.prepare('DELETE FROM clients WHERE id=? AND shop_id=?').bind(id, shop.id).run()
  return c.redirect('/dashboard/clients')
})

export default app
