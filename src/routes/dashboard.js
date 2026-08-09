import { Hono } from 'hono'
import { layout, money, esc } from '../lib/views.js'
import { genId } from '../lib/auth.js'
import { formatBookingTime, dateTzString, localToUtcMs } from '../lib/slots.js'
import { stripeClient } from '../lib/stripe.js'
import { sendCancellationEmail, sendBookingEmails, sendRescheduleEmail, sendTherapistInvite, sendReviewRequest } from '../lib/email.js'
import { findOrCreateClient } from '../lib/clients.js'
import { loyaltyStatus, tierDiscount, tierLabel, getTiers, loyaltyAvailByClient } from '../lib/loyalty.js'
import { freeTherapist, therapistFreeAt, shopHoursFor, availStartTimes } from '../lib/booking.js'
import qrcode from '../lib/qrcode.js'

// QR code as an inline SVG string (error-correction M, auto version).
const qrSvg = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag(5, 2) }

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
  return c.html(layout('Alisa', `
  <div class="dwrap">
    <aside class="dside">
      <a class="brand" href="/dashboard" style="padding:6px 10px 14px">💆 Alisa</a>
      ${tab('', '📊 Overview')}
      ${tab('roster', '📅 Roster')}
      ${tab('bookings', '🗓️ Bookings')}
      ${tab('clients', '👤 Clients')}
      ${tab('reviews', '⭐ Reviews')}
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
    .dside{width:220px;flex:0 0 220px;padding:18px 12px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto}
    .dtab{padding:11px 12px;border-radius:10px;color:var(--ink);font-weight:500;font-size:.92rem;white-space:nowrap}
    .dtab:hover{background:#f1ece5;text-decoration:none}
    .dtab.on{background:var(--accent);color:#fff}
    .dmain{flex:1;padding:26px 30px;min-width:0}
    .stat{font-family:'Fraunces',serif;font-size:2rem;font-weight:600}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);font-size:.9rem;vertical-align:top}
    th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
    .inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    /* iPad landscape / small laptops: slimmer rail */
    @media(max-width:1100px){.dside{width:190px;flex-basis:190px}.dmain{padding:22px 22px}}
    /* iPad portrait & phones: sticky horizontal nav that scrolls */
    @media(max-width:900px){
      .dwrap{flex-direction:column}
      .dside{width:auto;flex:none;height:auto;position:sticky;top:0;z-index:50;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;gap:4px;border-right:none;border-bottom:1px solid var(--line);background:var(--bg);padding:10px 12px;-webkit-overflow-scrolling:touch}
      .dside .brand{flex:0 0 auto;padding:6px 8px!important;font-size:1.2rem}
      .dside>div{display:none}
      .dtab{flex:0 0 auto}
      .dmain{padding:18px 15px}
      .card{overflow-x:auto}
    }
    /* larger tap targets on touch screens */
    @media(pointer:coarse){.btn.sm{padding:9px 15px}.dtab{padding:12px 14px}input,select,textarea{padding:13px 14px}}
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
      <p class="muted" style="margin:12px 0 0;font-size:.9rem">📍 <strong>Get bookings from Google Maps:</strong> in your <a href="https://business.google.com" target="_blank">Google Business Profile</a> → <strong>Edit profile → Booking / Appointment links</strong>, paste this link. Customers will see a <strong>“Book”</strong> button on your Maps listing.</p>
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


    <h3>Next appointments</h3>
    ${upcoming.length ? `<div class="card" style="padding:6px 18px"><table>
      <tr><th>When</th><th>Service</th><th>Client</th><th>Therapist</th><th></th></tr>
      ${upcoming.map(b => `<tr><td>${formatBookingTime(b.start_time, shop.timezone)}</td><td>${esc(b.service_name)}</td><td>${esc(b.customer_name)}</td><td>${esc(b.staff_name || '')}</td><td><span class="tag ${b.status}">${b.status.replace('_', ' ')}</span></td></tr>`).join('')}
    </table></div>` : '<p class="muted">No upcoming bookings yet — share your link to get started.</p>'}
  `)
})

// ─── Roster (day time-grid + week agenda) ────────────────────────────────────
app.get('/roster', async (c) => (c.req.query('view') === 'week') ? renderWeekRoster(c) : renderDayRoster(c))

const monOf = (date) => { const d = new Date(date + 'T12:00:00Z').getUTCDay(); return addDays(date, d === 0 ? -6 : 1 - d) }
const minsOfDay = (unix, tz) => { const [h, m] = hm(unix, tz).split(':').map(Number); return h * 60 + m }
const clockLabel = (mins) => { const h = Math.floor(mins / 60); return `${(h % 12) || 12} ${h < 12 ? 'am' : 'pm'}` }
const vtoggle = (view, date, weekStart) => `<div class="inline" style="gap:0;border:1px solid var(--line);border-radius:999px;overflow:hidden">
  <a class="vtab${view === 'day' ? ' on' : ''}" href="/dashboard/roster?view=day&date=${date}">Day</a>
  <a class="vtab${view === 'week' ? ' on' : ''}" href="/dashboard/roster?view=week&week=${weekStart}">Week</a></div>`

const ROSTER_CSS = `<style>
  .vtab{padding:6px 14px;font-size:.85rem;color:var(--ink);text-decoration:none}
  .vtab.on{background:var(--accent);color:#fff}
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
  .bk.pending_payment,.dblock.pending_payment{border-left-color:#c9a227;background:#fdf7e8}
  .bk.completed,.dblock.completed{border-left-color:#2f8a5b;background:#eef6f0}
  .bk.no_show,.dblock.no_show{border-left-color:#c0492f;background:#fbeae5}
  .bk.no_show{opacity:.75}
  .bkmeta{color:var(--muted);font-size:.7rem}
  .rnone{color:var(--muted);font-size:.74rem;padding:2px 0}
  .dg{display:grid;border:1px solid var(--line);border-radius:12px;overflow:auto;background:#fff;max-height:76vh}
  .dcolhead{padding:8px 10px;border-bottom:1px solid var(--line);border-left:1px solid var(--line);font-size:.82rem;font-weight:600;position:sticky;top:0;background:#fcfbf9;z-index:3;white-space:nowrap}
  .dcolhead .whrs{color:var(--muted);font-weight:400;margin-left:4px}
  .dcolhead.off{color:#8a6414}
  .dg-corner{border-bottom:1px solid var(--line);position:sticky;top:0;left:0;background:#fcfbf9;z-index:4}
  .dg-gutter{position:relative;background:#fcfbf9}
  .hourlab{height:60px;font-size:.68rem;color:var(--muted);text-align:right;padding:2px 6px 0;box-sizing:border-box}
  .dcolbody{position:relative;border-left:1px solid var(--line);cursor:copy;background:#fff}
  .dcolbody.dropcol{background:#eef7f5}
  .hrline{position:absolute;left:0;right:0;border-top:1px solid #f2efe9;pointer-events:none}
  .workband{position:absolute;left:0;right:0;background:#f4faf8;pointer-events:none}
  .offband{position:absolute;inset:0;background:repeating-linear-gradient(45deg,#faf1e6,#faf1e6 12px,#f6ead6 12px,#f6ead6 24px);color:#8a6414;display:flex;align-items:center;justify-content:center;font-size:.8rem;pointer-events:none}
  .dblock{position:absolute;left:3px;right:3px;border-radius:8px;padding:3px 7px;font-size:.72rem;line-height:1.22;overflow:hidden;border-left:3px solid var(--accent);background:#eef4f3;cursor:grab;touch-action:none;z-index:1;box-shadow:0 1px 2px rgba(28,43,42,.08)}
  .dblock:hover{filter:brightness(.97)}
  .dblock.dragging{opacity:.9;cursor:grabbing;z-index:9;box-shadow:0 8px 20px rgba(28,43,42,.22)}
  .dbpay{position:absolute;top:0;right:1px;font-size:.72rem;line-height:1.3;text-decoration:none;opacity:.6;z-index:3;padding:0 2px;cursor:pointer}
  .dbpay:hover{opacity:1;text-decoration:none}
  .dbtime{font-weight:700}
  .dbsvc{color:var(--muted)}
</style>`

async function renderWeekRoster(c) {
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
        <div class="bkmeta">${esc(b.customer_name)} · ${b.requested_staff ? '❤️ ' : ''}${b.group_id ? '👥 ' : ''}${esc(b.staff_name || '')}</div></a>`).join('')

    return `<div class="rcol${ds === today ? ' today' : ''}">
      <div class="rhead">${DOW[dow]} <span>${dnum}</span></div>
      <div class="rwork">${workHtml || '<div class="rnone">Closed</div>'}</div>
      <div class="rbook">${bkHtml || '<div class="rnone">No bookings</div>'}<a class="raddday" href="/dashboard/bookings/new?date=${ds}">＋ Add booking</a></div>
    </div>`
  }).join('')

  const label = `${niceOff(days[0])} – ${niceOff(days[6])}`
  const nav = `<div class="inline" style="gap:8px">
    <a class="btn ghost sm" href="/dashboard/roster?view=week&week=${addDays(weekStart, -7)}">← Prev</a>
    <a class="btn ghost sm" href="/dashboard/roster?view=week&week=${thisMonday}">This week</a>
    <a class="btn ghost sm" href="/dashboard/roster?view=week&week=${addDays(weekStart, 7)}">Next →</a>
  </div>`

  return shell(c, 'roster', 'Roster', `
    ${ROSTER_CSS}
    <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div class="inline" style="gap:12px"><h2 style="margin:0">Roster</h2>${vtoggle('week', today, weekStart)}</div>
      <div class="inline" style="gap:8px;flex-wrap:wrap"><a class="btn sm" href="/dashboard/bookings/new?date=${weekStart}">➕ Add booking</a><a class="btn ghost sm" href="/dashboard/bookings/group/new?date=${weekStart}">👥 Group</a>${nav}</div>
    </div>
    <div class="inline" style="gap:8px;align-items:center;margin:10px 0 0"><span class="muted" style="font-size:.85rem">📅 Jump to</span><input type="date" value="${weekStart}" onchange="if(this.value){var d=new Date(this.value+'T12:00:00Z'),g=d.getUTCDay();d.setUTCDate(d.getUTCDate()+(g===0?-6:1-g));location.href='/dashboard/roster?view=week&week='+d.toISOString().slice(0,10);}" aria-label="Jump to week" style="padding:7px 10px;border:1px solid var(--line);border-radius:9px;font:inherit;max-width:180px"></div>
    <div class="muted" style="margin:6px 0 12px">${label} · ${bookings.length} booking${bookings.length === 1 ? '' : 's'}</div>
    <div class="rgrid">${cols}</div>
  `)
}

async function renderDayRoster(c) {
  const db = c.env.DB, shop = c.get('shop'), tz = shop.timezone
  const today = dateTzString(new Date(), tz)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('date') || '') ? c.req.query('date') : today
  const dow = new Date(date + 'T12:00:00Z').getUTCDay()
  const interval = Math.max(5, Number(shop.slot_interval_minutes) || 15)

  const staff = (await db.prepare('SELECT id,name,emoji FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const avail = (await db.prepare('SELECT a.staff_id,a.start_time,a.end_time FROM availability a JOIN staff s ON s.id=a.staff_id WHERE s.shop_id=? AND a.day_of_week=?').bind(shop.id, dow).all()).results || []
  const availByStaff = {}; for (const a of avail) availByStaff[a.staff_id] = a
  const offIds = new Set(((await db.prepare('SELECT t.staff_id FROM time_off t JOIN staff s ON s.id=t.staff_id WHERE s.shop_id=? AND t.date=?').bind(shop.id, date).all()).results || []).map(o => o.staff_id))

  const dayStartU = Math.floor(localToUtcMs(date, '00:00', tz) / 1000)
  const bookings = (await db.prepare(`SELECT * FROM bookings WHERE shop_id=? AND start_time>=? AND start_time<? AND status!='cancelled' ORDER BY start_time`).bind(shop.id, dayStartU, dayStartU + 86400).all()).results || []
  const bkByStaff = {}; for (const b of bookings) (bkByStaff[b.staff_id] ||= []).push(b)

  // Grid time range: base on the shop's opening hours for this weekday (falling
  // back to 9–18), then widen to fit availability + any bookings.
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  const sh = shopHoursFor(shop, dow)
  let lo = sh ? toMin(sh.open) : 9 * 60, hi = sh ? toMin(sh.close) : 18 * 60
  for (const st of staff) { const a = availByStaff[st.id]; if (a && !offIds.has(st.id)) { lo = Math.min(lo, toMin(a.start_time)); hi = Math.max(hi, toMin(a.end_time)) } }
  for (const b of bookings) { lo = Math.min(lo, minsOfDay(b.start_time, tz)); hi = Math.max(hi, minsOfDay(b.end_time, tz)) }
  const gridStart = Math.max(0, Math.floor(lo / 60) * 60), gridEnd = Math.min(24 * 60, Math.ceil(hi / 60) * 60)
  const H = gridEnd - gridStart   // 1px per minute

  const hourLabels = []; for (let m = gridStart; m < gridEnd; m += 60) hourLabels.push(`<div class="hourlab">${clockLabel(m)}</div>`)
  const hrlines = []; for (let m = gridStart; m <= gridEnd; m += 60) hrlines.push(`<div class="hrline" style="top:${m - gridStart}px"></div>`)

  const cols = staff.map(st => {
    const a = availByStaff[st.id], off = offIds.has(st.id)
    const band = (a && !off) ? `<div class="workband" style="top:${toMin(a.start_time) - gridStart}px;height:${toMin(a.end_time) - toMin(a.start_time)}px"></div>` : ''
    const offb = off ? `<div class="offband">🌴 Day off</div>` : ''
    const blocks = (bkByStaff[st.id] || []).map(b => {
      const s = minsOfDay(b.start_time, tz), e = minsOfDay(b.end_time, tz)
      return `<div class="dblock ${b.status}" data-id="${b.id}"${b.requested_staff ? ' data-locked="1"' : ''} data-edit="/dashboard/bookings/${b.id}/edit" data-move="/dashboard/bookings/${b.id}/move" style="top:${s - gridStart}px;height:${Math.max(20, e - s)}px" title="${b.requested_staff ? 'Requested therapist (locked) · ' : ''}Drag to move · click to edit">
        <a class="dbpay" href="/dashboard/bookings/${b.id}/pay" title="Take payment">💳</a><div class="dbtime">${timeOnly(b.start_time, tz)}${b.requested_staff ? ' ❤️' : ''}${b.group_id ? ' 👥' : ''}</div><div class="dbname">${esc(b.customer_name)}</div><div class="dbsvc">${esc(b.service_name || '')}</div></div>`
    }).join('')
    const hrs = (a && !off) ? `<span class="whrs">${a.start_time}–${a.end_time}</span>` : `<span class="whrs">${off ? 'off' : 'closed'}</span>`
    return {
      head: `<div class="dcolhead${off ? ' off' : ''}">${esc(st.emoji)} ${esc(st.name.split(' ')[0])} ${hrs}</div>`,
      body: `<div class="dcolbody" data-staff="${st.id}" style="height:${H}px">${band}${offb}${hrlines.join('')}${blocks}</div>`,
    }
  })

  const nav = `<div class="inline" style="gap:8px">
    <a class="btn ghost sm" href="/dashboard/roster?view=day&date=${addDays(date, -1)}">← Prev</a>
    <a class="btn ghost sm" href="/dashboard/roster?view=day&date=${today}">Today</a>
    <a class="btn ghost sm" href="/dashboard/roster?view=day&date=${addDays(date, 1)}">Next →</a></div>`
  const heading = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })
  const n = staff.length

  return shell(c, 'roster', 'Roster', `
    ${ROSTER_CSS}
    <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div class="inline" style="gap:12px"><h2 style="margin:0">Roster</h2>${vtoggle('day', date, monOf(date))}</div>
      <div class="inline" style="gap:8px;flex-wrap:wrap"><a class="btn sm" href="/dashboard/bookings/new?date=${date}">➕ Add booking</a><a class="btn ghost sm" href="/dashboard/bookings/group/new?date=${date}">👥 Group</a><a class="btn ghost sm" href="/dashboard/day-sheet?date=${date}" target="_blank">🧾 Day sheet</a>${nav}</div>
    </div>
    <div class="inline" style="gap:8px;align-items:center;margin:10px 0 0"><span class="muted" style="font-size:.85rem">📅 Jump to</span><input type="date" value="${date}" onchange="if(this.value)location.href='/dashboard/roster?view=day&date='+this.value" aria-label="Jump to date" style="padding:7px 10px;border:1px solid var(--line);border-radius:9px;font:inherit;max-width:180px"></div>
    <div class="muted" style="margin:6px 0 12px">${heading}${date === today ? ' · today' : ''} · ${bookings.length} booking${bookings.length === 1 ? '' : 's'} · <span style="font-size:.9em">drag a booking to reschedule · click a slot to add</span></div>
    ${n ? `<div class="dg" style="grid-template-columns:52px repeat(${n},minmax(130px,1fr))">
      <div class="dg-corner"></div>${cols.map(x => x.head).join('')}
      <div class="dg-gutter" style="height:${H}px">${hourLabels.join('')}</div>${cols.map(x => x.body).join('')}
    </div>` : '<p class="muted">Add a therapist to see the day grid.</p>'}
    <script>
    (function(){
      const GRID_START=${gridStart}, INTERVAL=${interval}, DATE=${JSON.stringify(date)};
      const bodies=[...document.querySelectorAll('.dcolbody')];
      const colUnder=x=>{for(const b of bodies){const r=b.getBoundingClientRect();if(x>=r.left&&x<=r.right)return b;}return null;};
      const fmt=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
      let d=null;
      document.querySelectorAll('.dblock').forEach(el=>{
        el.addEventListener('pointerdown',e=>{ if(e.button>0)return; if(e.target.closest('.dbpay'))return; e.preventDefault();
          const r=el.getBoundingClientRect();
          d={el,moved:false,sx:e.clientX,sy:e.clientY,offX:e.clientX-r.left,offY:e.clientY-r.top,w:r.width,origin:el.parentElement,tCol:el.parentElement};
          try{el.setPointerCapture(e.pointerId);}catch(_){} });
        el.addEventListener('pointermove',e=>{ if(!d||d.el!==el)return;
          if(!d.moved && (Math.abs(e.clientX-d.sx)>4||Math.abs(e.clientY-d.sy)>4)){ d.moved=true;
            // Detach into a floating card so it can travel across columns under the finger/cursor.
            el.classList.add('dragging'); el.style.position='fixed'; el.style.margin='0';
            el.style.width=d.w+'px'; el.style.right='auto'; el.style.zIndex='9999'; }
          if(!d.moved)return;
          el.style.left=(e.clientX-d.offX)+'px'; el.style.top=(e.clientY-d.offY)+'px';
          const col=el.dataset.locked?d.origin:(colUnder(e.clientX)||d.origin); d.tCol=col;
          bodies.forEach(b=>b.classList.toggle('dropcol',b===col)); });
        el.addEventListener('pointerup',async e=>{ if(!d||d.el!==el)return;
          try{el.releasePointerCapture(e.pointerId);}catch(_){}
          bodies.forEach(b=>b.classList.remove('dropcol'));
          if(!d.moved){ el.classList.remove('dragging'); location.href=el.dataset.edit; d=null; return; }
          const col=d.tCol||d.origin, cr=col.getBoundingClientRect();
          let topInCol=Math.max(0,Math.min((e.clientY-d.offY)-cr.top, col.clientHeight-el.offsetHeight));
          const mins=GRID_START+Math.round(topInCol/INTERVAL)*INTERVAL;
          const staff=col.dataset.staff, url=el.dataset.move; d=null;
          try{ var resp=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({date:DATE,staff_id:staff,start:fmt(mins)})}); if(resp&&!resp.ok){ alert('That therapist is already booked at that time — the appointment was left where it was.'); } }catch(_){}
          location.reload(); });
      });
      bodies.forEach(body=>{ body.addEventListener('click',e=>{ if(e.target.closest('.dblock'))return; if(d)return;
        const r=body.getBoundingClientRect(); const mins=GRID_START+Math.round((e.clientY-r.top)/INTERVAL)*INTERVAL;
        location.href='/dashboard/bookings/new?date='+DATE+'&staff='+body.dataset.staff+'&start='+encodeURIComponent(fmt(mins)); }); });
      // Auto-refresh so the front desk always sees the latest — but never mid-drag or on a hidden tab.
      setInterval(()=>{ if(!d && !document.hidden) location.reload(); }, 60000);
    })();
    </script>
  `)
}

app.post('/bookings/:id/move', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), id = c.req.param('id')
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(id, shop.id).first()
  if (!b) return c.json({ error: 'not found' }, 404)
  const f = await c.req.parseBody()
  const date = (f.date || '').toString(), startT = (f.start || '').toString(), staffId = (f.staff_id || '').toString()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(startT) || !staffId) return c.json({ error: 'bad input' }, 400)
  const staff = await db.prepare('SELECT id,name FROM staff WHERE id=? AND shop_id=?').bind(staffId, shop.id).first()
  if (!staff) return c.json({ error: 'bad staff' }, 400)
  const dur = b.end_time - b.start_time
  const startUnix = Math.floor(localToUtcMs(date, startT, shop.timezone) / 1000)
  // If the client requested this therapist, the time can change but the
  // therapist stays locked.
  const finalStaffId = b.requested_staff ? b.staff_id : staff.id
  const finalStaffName = b.requested_staff ? b.staff_name : staff.name
  // No double-booking: the target therapist must be free at the new time.
  if (!(await therapistFreeAt(db, finalStaffId, startUnix, startUnix + dur, id))) return c.json({ error: 'busy' }, 409)
  await db.prepare('UPDATE bookings SET start_time=?, end_time=?, staff_id=?, staff_name=? WHERE id=?')
    .bind(startUnix, startUnix + dur, finalStaffId, finalStaffName, id).run()
  if (b.customer_email && startUnix !== b.start_time) {
    const p = sendRescheduleEmail(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
  }
  return c.json({ ok: true })
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
    <div class="inline" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;padding:6px 0 4px;margin-bottom:8px"><h2 style="margin:0">Bookings</h2><div class="inline" style="gap:8px;flex-wrap:wrap;row-gap:8px"><a class="btn sm" href="/dashboard/bookings/new">➕ Add booking</a><a class="btn ghost sm" href="/dashboard/bookings/group/new">👥 Group</a>${tabs}</div></div>
    ${rows.length ? `<div class="card" style="padding:6px 18px"><table>
      <tr><th>When</th><th>Client</th><th>Service</th><th>Therapist</th><th>Deposit</th><th>Status</th><th></th></tr>
      ${rows.map(b => `<tr>
        <td>${formatBookingTime(b.start_time, shop.timezone)}</td>
        <td>${esc(b.customer_name)}<div class="muted" style="font-size:.8rem">${esc(b.customer_email)}${b.customer_phone ? ' · ' + esc(b.customer_phone) : ''}</div>${b.notes ? `<div class="muted" style="font-size:.8rem">📝 ${esc(b.notes)}</div>` : ''}</td>
        <td>${esc(b.service_name)}</td>
        <td>${b.requested_staff ? '❤️ ' : ''}${esc(b.staff_name || '')}</td>
        <td>${b.deposit_cents ? money(b.deposit_cents, shop.currency) : '—'}${b.refunded_at ? '<div class="muted" style="font-size:.75rem">refunded</div>' : ''}</td>
        <td><span class="tag ${b.status}">${b.status.replace('_', ' ')}</span></td>
        <td><div class="inline">
          ${['confirmed', 'pending_payment', 'completed'].includes(b.status) ? `<a class="btn gold sm" href="/dashboard/bookings/${b.id}/pay">💳 Pay</a>` : ''}
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

  if (action === 'complete') {
    await db.prepare("UPDATE bookings SET status='completed' WHERE id=?").bind(id).run()
    // Ask the customer for a review (once). Non-blocking.
    const p = sendReviewRequest(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
  }
  if (action === 'no_show') await db.prepare("UPDATE bookings SET status='no_show' WHERE id=?").bind(id).run()
  if (action === 'cancel') {
    // A group booking cancels as one: cancel every member, refund the single
    // group deposit once, restore each person's loyalty, and email each guest.
    let targets = b.group_id
      ? (await db.prepare("SELECT * FROM bookings WHERE group_id=? AND shop_id=? AND status IN ('confirmed','pending_payment')").bind(b.group_id, shop.id).all()).results || []
      : [b]
    if (!targets.length) targets = [b]
    const charged = targets.find(x => x.stripe_charge_id && !x.refunded_at)
    if (charged && c.env.STRIPE_SECRET_KEY && shop.stripe_account_id) {
      try {
        // Refund on the shop's connected account and hand back the 1% platform fee too.
        await stripeClient(c.env.STRIPE_SECRET_KEY).createRefund(
          { charge: charged.stripe_charge_id, reason: 'requested_by_customer', refund_application_fee: true },
          { account: shop.stripe_account_id })
        await db.prepare("UPDATE bookings SET refunded_at = unixepoch() WHERE id=?").bind(charged.id).run()
      } catch (e) { console.error('refund failed:', e.message) }
    }
    const emailIds = []
    for (const x of targets) {
      await db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").bind(x.id).run()
      if (x.loyalty_applied > 0) await db.prepare('DELETE FROM loyalty_redemptions WHERE booking_id=?').bind(x.id).run()
      if (x.customer_email) emailIds.push(x.id)
    }
    const emailP = Promise.all(emailIds.map(eid => sendCancellationEmail(c.env, eid)))
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
// `loyaltyOn` shows an "apply loyalty reward" picker (create only).
function bookingForm(shop, staff, services, clients, action, submitLabel, v = {}, loyaltyOn = false) {
  // On a NEW booking, preselect the first real service so the end time + price
  // are computed from the start straight away (Custom = no duration = no auto-end).
  const selService = v.editing ? (v.service_id || '') : (v.service_id != null && v.service_id !== '' ? v.service_id : (services[0] ? services[0].id : ''))
  return `
    <form method="post" action="${action}" class="card" style="padding:22px;max-width:580px">
      <div class="row">
        <div class="field"><label>Date</label><input type="date" name="date" value="${v.date || ''}" required></div>
        <div class="field"><label>Therapist</label><select name="staff_id" required><option value="any" ${!v.staff_id || v.staff_id === 'any' ? 'selected' : ''}>✨ Any available</option>${staff.map(s => `<option value="${s.id}" ${v.staff_id === s.id ? 'selected' : ''}>${esc(s.emoji)} ${esc(s.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Service</label>
        <select name="service_id" id="svc">
          <option value="" ${selService === '' ? 'selected' : ''}>Custom / other</option>
          ${services.map(s => `<option value="${s.id}" data-dur="${s.duration_minutes}" data-price="${s.price_cents}" ${selService === s.id ? 'selected' : ''}>${esc(s.name)} · ${s.duration_minutes} min</option>`).join('')}
        </select>
      </div>
      <div class="row" style="max-width:360px">
        <div class="field" style="flex:0 0 165px"><label>Start time <span class="muted">(available)</span></label><select name="start" id="st" required><option value="${v.start || '09:00'}">${v.start || '09:00'}</option></select></div>
        <div class="field" style="flex:0 0 150px"><label>End time</label><input type="time" name="end" id="et" step="300" value="${v.end || '10:00'}" required></div>
      </div>
      <div class="row">
        <div class="field"><label>Custom label <span class="muted">(optional)</span></label><input name="custom_name" value="${esc(v.custom_name || '')}" placeholder="e.g. Extended session"></div>
        <div class="field" style="flex:0 0 150px"><label>Price (${shop.currency.toUpperCase()})</label><input type="number" name="price" id="pr" min="0" step="1" value="${v.price != null ? v.price : ''}"></div>
      </div>

      <style>
        .acwrap{position:relative}
        .acmenu{position:absolute;left:0;right:0;top:100%;z-index:40;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);margin-top:4px;max-height:260px;overflow:auto}
        .acitem{padding:9px 12px;cursor:pointer;font-size:.9rem;border-bottom:1px solid #f2efe9}
        .acitem:last-child{border-bottom:none}
        .acitem:hover,.acitem.sel{background:#f1ece5}
        .acitem .acsub{color:var(--muted);font-size:.8rem}
        .acnew{color:var(--accent-ink);font-weight:600}
      </style>
      <div class="field acwrap"><label>Client <span class="muted">(search saved by name or phone)</span></label>
        <input type="text" id="clientsearch" autocomplete="off" placeholder="Type a name or phone number…" value="${v.client_id ? esc(v.customer_name || '') : ''}">
        <div id="clientresults" class="acmenu" style="display:none"></div>
        <p class="muted" style="font-size:.78rem;margin:4px 0 0">Reuse a saved client, or just fill the details below for a new one.</p>
      </div>
      <input type="hidden" name="client_id" id="client_id" value="${v.client_id || ''}">
      <div id="clientnotes" class="notice" style="display:none;background:#fdf7e8;color:#8a6414;white-space:pre-wrap"></div>

      <div class="row">
        <div class="field"><label>Customer name</label><input name="customer_name" id="cn" value="${esc(v.customer_name || '')}" placeholder="Walk-in"></div>
        <div class="field"><label>Phone <span class="muted">(optional)</span></label><input name="customer_phone" id="cp" value="${esc(v.customer_phone || '')}"></div>
      </div>
      <div class="field"><label>Customer email <span class="muted">(optional — emails a confirmation/update)</span></label><input type="email" name="customer_email" id="ce" value="${esc(v.customer_email || '')}"></div>
      <div class="field"><label>Appointment notes <span class="muted">(this booking only)</span></label><input name="notes" value="${esc(v.notes || '')}" placeholder="Injuries, preferences…"></div>
      <div class="field"><label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer"><input type="checkbox" name="requested_staff" value="1" style="width:auto" ${v.requested_staff ? 'checked' : ''}> ❤️ Client requested this therapist — don’t reassign to anyone else</label></div>
      ${loyaltyOn ? `<div class="field" id="loyaltyrow" style="display:none"><label style="color:#8a6414">🎁 Apply loyalty reward</label><select name="loyalty_milestone" id="loyaltysel"><option value="">— none —</option></select></div>` : ''}
      <button class="btn">${submitLabel}</button>
    </form>
    <script>
    // Picking a service auto-fills the end time (start + duration) and price,
    // but both stay fully editable — that's the point of custom bookings.
    const svc=document.getElementById('svc'),st=document.getElementById('st'),et=document.getElementById('et'),pr=document.getElementById('pr'),clbl=document.querySelector('[name=custom_name]');
    const dateEl=document.querySelector('[name=date]'),staffEl=document.querySelector('[name=staff_id]');
    var EDITING=${v.editing ? 'true' : 'false'};
    function fillEnd(){const o=svc.selectedOptions[0],d=o&&o.dataset.dur?+o.dataset.dur:0;if(!d||!st.value)return;const p=st.value.split(':').map(Number);let t=Math.min(p[0]*60+p[1]+d,23*60+55);et.value=String(Math.floor(t/60)).padStart(2,'0')+':'+String(t%60).padStart(2,'0');}
    // Start time only offers times a therapist is genuinely free (date + therapist
    // + service duration). Reloads when any of those change.
    async function loadTimes(){ if(!dateEl||!dateEl.value)return; var cur=st.value;
      try{ var r=await fetch('/dashboard/avail-times?date='+encodeURIComponent(dateEl.value)+'&staff='+encodeURIComponent(staffEl?staffEl.value:'any')+'&service='+encodeURIComponent(svc.value));
        var j=await r.json(); var times=j.times||[]; var inList=times.some(function(t){return t.hm===cur;});
        var opts=times.map(function(t){return '<option value="'+t.hm+'">'+t.display+'</option>';}).join('');
        if(EDITING&&cur&&!inList) opts='<option value="'+cur+'">'+cur+' (current)</option>'+opts;
        if(!opts) opts='<option value="">No free times — try another day or therapist</option>';
        st.innerHTML=opts;
        st.value = inList ? cur : (EDITING&&cur ? cur : (times[0]?times[0].hm:''));
        fillEnd();
      }catch(e){}
    }
    // Switching to a real service adopts ITS name, price and duration — clear any
    // stale custom label and set the price so edits update correctly (create+edit).
    svc.addEventListener('change',()=>{const o=svc.selectedOptions[0];if(o&&o.value){if(o.dataset.price)pr.value=(+o.dataset.price/100).toFixed(0);if(clbl)clbl.value='';}loadTimes();});
    if(dateEl)dateEl.addEventListener('change',loadTimes);
    if(staffEl)staffEl.addEventListener('change',loadTimes);
    st.addEventListener('change',fillEnd);
    // Preselected service on a new booking: seed the price now (change won't fire).
    (function(){var o=svc.selectedOptions[0];if(o&&o.value&&o.dataset.price&&!pr.value)pr.value=(+o.dataset.price/100).toFixed(0);})();
    loadTimes();
    // Searchable client picker — filter saved clients by name / phone / email.
    var CLIENTS=${JSON.stringify(clients.map(cl => ({ id: cl.id, name: cl.name, email: cl.email || '', phone: cl.phone || '', notes: cl.notes || '', rewards: cl.rewards || [] })))};
    var cs=document.getElementById('clientsearch'),cid=document.getElementById('client_id'),cres=document.getElementById('clientresults'),cnb=document.getElementById('clientnotes'),cn=document.getElementById('cn'),ce=document.getElementById('ce'),cp=document.getElementById('cp');
    var loyrow=document.getElementById('loyaltyrow'),loysel=document.getElementById('loyaltysel');
    function acEsc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
    function showNotes(n){ if(n){cnb.textContent='📋 '+n;cnb.style.display='block';} else {cnb.style.display='none';} }
    function showLoyalty(c){ if(!loyrow||!loysel)return; var rw=(c&&c.rewards)||[]; if(rw.length){ loysel.innerHTML='<option value="">— none —</option>'+rw.map(function(r){return '<option value="'+r.visits+'">'+acEsc(r.label)+' ('+r.visits+' visits)</option>';}).join(''); loyrow.style.display=''; } else { loysel.innerHTML='<option value="">— none —</option>'; loyrow.style.display='none'; } }
    function pick(c){ cid.value=c.id; cs.value=c.name; cn.value=c.name; ce.value=c.email; cp.value=c.phone; showNotes(c.notes); showLoyalty(c); cres.style.display='none'; }
    function newClient(){ cid.value=''; showNotes(''); showLoyalty(null); cres.style.display='none'; cn.focus(); }
    function digits(s){return String(s).replace(/\\D/g,'');}
    function search(){ var q=cs.value.trim().toLowerCase(), qd=digits(q);
      var list = q ? CLIENTS.filter(function(c){ return c.name.toLowerCase().indexOf(q)>=0 || (qd && digits(c.phone).indexOf(qd)>=0) || (c.email && c.email.toLowerCase().indexOf(q)>=0); }) : [];
      var html = list.slice(0,8).map(function(c,i){ return '<div class="acitem" data-i="'+i+'"><div>'+acEsc(c.name)+'</div><div class="acsub">'+[acEsc(c.phone),acEsc(c.email)].filter(Boolean).join(' · ')+'</div></div>'; }).join('');
      html += '<div class="acitem acnew" data-new="1">➕ New client — use the details below</div>';
      cres.innerHTML=html; cres._list=list; cres.style.display='block';
    }
    cs.addEventListener('input',function(){ cid.value=''; search(); });
    cs.addEventListener('focus',search);
    cres.addEventListener('mousedown',function(e){ var it=e.target.closest('.acitem'); if(!it)return; e.preventDefault(); if(it.dataset.new){newClient();} else {pick(cres._list[+it.dataset.i]);} });
    document.addEventListener('click',function(e){ if(!cres.contains(e.target)&&e.target!==cs) cres.style.display='none'; });
    // On an edit/prefill with a linked client, show their notes + loyalty straight away.
    (function(){ if(cid.value){ var c=CLIENTS.filter(function(x){return x.id===cid.value;})[0]; if(c){ showNotes(c.notes); showLoyalty(c); } } })();
    </script>`
}

// Parse + validate the shared booking form. Returns { error } or the resolved fields.
async function resolveBookingInput(c, shop, excludeId = null) {
  const db = c.env.DB, f = await c.req.parseBody()
  const date = (f.date || '').toString(), startT = (f.start || '').toString(), endT = (f.end || '').toString()
  const staffId = (f.staff_id || '').toString()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(startT) || !/^\d{1,2}:\d{2}$/.test(endT)) return { error: true, date }
  const startUnix = Math.floor(localToUtcMs(date, startT, shop.timezone) / 1000)
  const endUnix = Math.floor(localToUtcMs(date, endT, shop.timezone) / 1000)
  if (endUnix <= startUnix) return { error: true, date }

  // service_id is a NOT NULL foreign key D1 enforces, so anchor to a real row.
  const customName = (f.custom_name || '').toString().trim()
  let sv = f.service_id ? await db.prepare('SELECT id,name,price_cents,duration_minutes FROM services WHERE id=? AND shop_id=?').bind(f.service_id.toString(), shop.id).first() : null
  const explicit = !!sv
  if (!sv) sv = await db.prepare('SELECT id,name,price_cents,duration_minutes FROM services WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at LIMIT 1').bind(shop.id).first()
  if (!sv) return { error: true, date }

  // Therapist: a specific one (must be free) or "any available" → a free one.
  let staff = null
  if (staffId && staffId !== 'any') {
    staff = await db.prepare('SELECT id,name FROM staff WHERE id=? AND shop_id=?').bind(staffId, shop.id).first()
    // No double-booking a therapist over an existing appointment.
    if (staff && !(await therapistFreeAt(db, staff.id, startUnix, endUnix, excludeId))) return { error: true, date, busy: true }
  }
  if (!staff) staff = await freeTherapist(db, shop, sv, startUnix, endUnix, new Set(), excludeId)
  if (!staff) return { error: true, date, busy: true }

  const priceStr = (f.price || '').toString().trim()
  const priceCents = priceStr !== '' ? Math.max(0, Math.round(parseFloat(priceStr) * 100) || 0) : (explicit ? sv.price_cents : 0)

  const customerName = (f.customer_name || '').toString().trim() || 'Walk-in'
  const email = (f.customer_email || '').toString().trim().toLowerCase()
  const phone = (f.customer_phone || '').toString().trim()
  // Link to a saved client: the one picked (keep its contact fresh) or find/create by contact.
  let clientId = (f.client_id || '').toString() || null
  if (clientId) {
    const cl = await db.prepare('SELECT id FROM clients WHERE id=? AND shop_id=?').bind(clientId, shop.id).first()
    // Update the name, but never clobber a saved email/phone with a blank one.
    if (cl) await db.prepare("UPDATE clients SET name=?, email=COALESCE(NULLIF(?,''), email), phone=COALESCE(NULLIF(?,''), phone), updated_at=unixepoch() WHERE id=?").bind(customerName, email, phone, clientId).run()
    else clientId = null
  }
  if (!clientId) clientId = await findOrCreateClient(db, shop.id, { name: customerName, email, phone })

  return {
    date, staff, startUnix, endUnix, serviceId: sv.id, serviceName: customName || sv.name, priceCents,
    customerName, email, phone, clientId, notes: (f.notes || '').toString(), requested: f.requested_staff ? 1 : 0,
    loyaltyMilestone: parseInt(f.loyalty_milestone) || 0,
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
  const avail = await loyaltyAvailByClient(db, shop)
  clients.forEach(cl => { cl.rewards = avail[cl.id] || [] })
  const loyOn = !!shop.loyalty_enabled
  const v = { date, staff_id: c.req.query('staff') || staff[0].id }
  // Prefill the client (name/phone/email) when arriving from a client's "Book again".
  const clientQ = c.req.query('client')
  if (clientQ) {
    const cl = await db.prepare('SELECT * FROM clients WHERE id=? AND shop_id=?').bind(clientQ, shop.id).first()
    if (cl) { v.client_id = cl.id; v.customer_name = cl.name; v.customer_email = cl.email || ''; v.customer_phone = cl.phone || '' }
  }
  const startQ = c.req.query('start')
  if (/^\d{1,2}:\d{2}$/.test(startQ || '')) {
    v.start = startQ
    const [h, m] = startQ.split(':').map(Number), t = Math.min(h * 60 + m + 60, 23 * 60 + 55)
    v.end = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
  }
  return shell(c, 'bookings', 'Add booking', `
    <a href="/dashboard/roster" class="muted">← Back to roster</a>
    <h2>Add a booking</h2>
    <p class="muted" style="margin-top:-6px">Schedule an appointment — the start time only lists times the therapist is free. Adjust the end time for a longer or shorter session.</p>
    ${c.req.query('err') === 'busy' ? '<div class="notice err" style="max-width:580px">⚠️ That therapist is already booked over that time — pick another time or therapist (or use “Any available”).</div>' : ''}
    ${bookingForm(shop, staff, services, clients, '/dashboard/bookings/new', 'Add booking', v, loyOn)}
  `)
})

app.post('/bookings/new', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const r = await resolveBookingInput(c, shop)
  if (r.error) return c.redirect(`/dashboard/bookings/new?date=${r.date || ''}${r.busy ? '&err=busy' : ''}`)

  // Apply a chosen loyalty reward tier if the client genuinely has it available.
  let priceCents = r.priceCents, loyaltyApplied = 0, redeemMilestone = 0
  if (r.loyaltyMilestone && r.clientId && shop.loyalty_enabled) {
    const client = await db.prepare('SELECT * FROM clients WHERE id=? AND shop_id=?').bind(r.clientId, shop.id).first()
    const st = await loyaltyStatus(db, shop, client)
    const tier = st.available && st.available.find(t => t.visits === r.loyaltyMilestone)
    if (tier) {
      loyaltyApplied = tierDiscount(tier, priceCents)
      priceCents = Math.max(0, priceCents - loyaltyApplied)
      redeemMilestone = r.loyaltyMilestone
    }
  }

  const id = genId()
  await db.prepare(`INSERT INTO bookings
    (id, shop_id, service_id, staff_id, customer_name, customer_email, customer_phone,
     start_time, end_time, status, price_cents, deposit_cents, service_name, staff_name, notes, lang, client_id, requested_staff, loyalty_applied)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 0, ?, ?, ?, 'en', ?, ?, ?)`)
    .bind(id, shop.id, r.serviceId, r.staff.id, r.customerName, r.email, r.phone,
      r.startUnix, r.endUnix, priceCents, r.serviceName, r.staff.name, r.notes, r.clientId, r.requested, loyaltyApplied).run()
  if (redeemMilestone) await db.prepare('INSERT INTO loyalty_redemptions (id, shop_id, client_id, milestone, discount_cents, booking_id) VALUES (?, ?, ?, ?, ?, ?)').bind(genId(), shop.id, r.clientId, redeemMilestone, loyaltyApplied, id).run()

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
  // Ensure this booking is linked to a saved client (older bookings may not be),
  // so the client name is clickable and opens a real profile.
  if (!b.client_id && (b.customer_email || b.customer_phone)) {
    const cid = await findOrCreateClient(db, shop.id, { name: b.customer_name, email: b.customer_email, phone: b.customer_phone })
    if (cid) { await db.prepare('UPDATE bookings SET client_id=? WHERE id=?').bind(cid, b.id).run(); b.client_id = cid }
  }
  const staff = (await db.prepare('SELECT id,name,emoji FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const services = (await db.prepare('SELECT id,name,duration_minutes,price_cents FROM services WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const clients = await clientsForShop(db, shop.id)
  // The "custom label" is only a genuine override when it differs from the
  // linked service's own name — otherwise leave it blank so switching the
  // service dropdown adopts the new service's name (not the old one).
  const svcRow = services.find(s => s.id === b.service_id)
  const v = {
    date: dateTzString(new Date(b.start_time * 1000), shop.timezone),
    start: hm(b.start_time, shop.timezone), end: hm(b.end_time, shop.timezone),
    staff_id: b.staff_id, service_id: b.service_id, custom_name: (svcRow && b.service_name === svcRow.name) ? '' : b.service_name,
    // Blank when it just matches the service price → a blank field means "use the
    // selected service's price", so switching services updates price server-side too.
    price: (svcRow && b.price_cents === svcRow.price_cents) ? '' : (b.price_cents ? b.price_cents / 100 : ''),
    client_id: b.client_id || '', requested_staff: b.requested_staff, editing: true,
    customer_name: b.customer_name, customer_email: b.customer_email, customer_phone: b.customer_phone, notes: b.notes,
  }

  // This client's payment + service history (matched by client_id OR email).
  const email = b.customer_email || ''
  const hist = (await db.prepare(
    `SELECT * FROM bookings WHERE shop_id=? AND (client_id=? OR (? <> '' AND lower(customer_email)=lower(?))) ORDER BY start_time DESC LIMIT 60`
  ).bind(shop.id, b.client_id || '', email, email).all()).results || []
  const tot = await db.prepare(
    `SELECT COUNT(*) visits, COALESCE(SUM(end_time-start_time),0) secs, COALESCE(SUM(price_cents),0) spent
     FROM bookings WHERE shop_id=? AND (client_id=? OR (? <> '' AND lower(customer_email)=lower(?))) AND status IN ('confirmed','completed')`
  ).bind(shop.id, b.client_id || '', email, email).first()
  const totMin = Math.round((tot?.secs || 0) / 60)
  const totTime = totMin >= 60 ? `${Math.floor(totMin / 60)}h ${totMin % 60}m` : `${totMin}m`

  const historyPanel = `
    <div>
      <div class="inline" style="justify-content:space-between;align-items:center;gap:8px">
        <h3 style="margin:0">${b.client_id ? `<a href="/dashboard/clients/${b.client_id}">${esc(b.customer_name || 'Walk-in')}</a>` : esc(b.customer_name || 'Walk-in')}</h3>
        ${b.client_id ? `<a class="btn ghost sm" href="/dashboard/clients/${b.client_id}">Full profile →</a>` : ''}
      </div>
      <div class="muted" style="font-size:.85rem;margin:2px 0 12px">${[b.customer_phone, b.customer_email].filter(Boolean).map(esc).join(' · ') || 'No contact on file'}</div>
      <div class="grid g3" style="margin-bottom:14px">
        <div class="card" style="padding:14px"><div class="muted" style="font-size:.8rem">Visits</div><div class="stat" style="font-size:1.5rem">${tot?.visits || 0}</div></div>
        <div class="card" style="padding:14px"><div class="muted" style="font-size:.8rem">Total time</div><div class="stat" style="font-size:1.5rem">${totTime}</div></div>
        <div class="card" style="padding:14px"><div class="muted" style="font-size:.8rem">Total pay</div><div class="stat" style="font-size:1.5rem">${money(tot?.spent || 0, shop.currency)}</div></div>
      </div>
      <h4 style="margin:0 0 6px">Payment &amp; service history</h4>
      ${hist.length ? `<div class="card" style="padding:6px 16px;max-height:440px;overflow:auto"><table>
        <tr><th>When</th><th>Service</th><th>Price</th><th>Deposit</th><th>Status</th><th>Notes</th></tr>
        ${hist.map(h => `<tr${h.id === b.id ? ' style="background:#f4faf8"' : ''}>
          <td>${esc(formatBookingTime(h.start_time, shop.timezone))}</td>
          <td>${h.requested_staff ? '❤️ ' : ''}${esc(h.service_name || '')}</td>
          <td>${money(h.price_cents, shop.currency)}</td>
          <td>${h.deposit_cents ? money(h.deposit_cents, shop.currency) : '—'}${h.refunded_at ? ' <span class="muted" style="font-size:.7rem">(refunded)</span>' : ''}</td>
          <td><span class="tag ${h.status}">${h.status.replace('_', ' ')}</span></td>
          <td class="muted" style="font-size:.82rem;max-width:220px;white-space:pre-wrap">${h.notes ? esc(h.notes) : '—'}</td>
        </tr>`).join('')}
      </table></div>` : '<p class="muted">No history yet.</p>'}
    </div>`

  return shell(c, 'bookings', 'Edit booking', `
    <a href="/dashboard/roster" class="muted">← Back to roster</a>
    <h2>Edit / reschedule booking</h2>
    ${c.req.query('err') === 'busy' ? '<div class="notice err" style="max-width:580px;margin-bottom:10px">⚠️ That therapist is already booked over that time — pick another time or therapist.</div>' : ''}
    <p class="muted" style="margin-top:-6px">Change the time, therapist or details. <span class="tag ${b.status}">${b.status.replace('_', ' ')}</span>${b.loyalty_applied > 0 ? ` · 🎁 <strong>${money(b.loyalty_applied, shop.currency)} loyalty reward applied</strong>` : ''}${b.group_id ? ` · 👥 <strong>Group booking</strong>${b.room ? ` (${esc(b.room)})` : ''}` : ''}</p>
    ${['confirmed', 'pending_payment', 'completed'].includes(b.status) ? `<div class="inline" style="gap:8px;margin:0 0 14px;flex-wrap:wrap">
      <a class="btn sm gold" href="/dashboard/bookings/${b.id}/pay">💳 Take payment</a>
      ${['confirmed', 'pending_payment'].includes(b.status) ? `<form method="post" action="/dashboard/bookings/${b.id}/complete"><button class="btn sm">✓ Mark done</button></form>
      <form method="post" action="/dashboard/bookings/${b.id}/no_show"><button class="btn ghost sm">No-show</button></form>
      <form method="post" action="/dashboard/bookings/${b.id}/cancel" onsubmit="return confirm('${b.group_id ? 'Cancel the whole group booking' : 'Cancel this booking'}${b.stripe_charge_id ? ' and refund the deposit' : ''}?')"><button class="btn danger sm">✕ Cancel booking</button></form>` : ''}
    </div>` : ''}
    <div class="grid g2" style="align-items:start">
      <div>${bookingForm(shop, staff, services, clients, `/dashboard/bookings/${b.id}/edit`, 'Save changes', v)}</div>
      ${historyPanel}
    </div>
  `)
})

app.post('/bookings/:id/edit', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), id = c.req.param('id')
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(id, shop.id).first()
  if (!b) return c.redirect('/dashboard/bookings')
  const r = await resolveBookingInput(c, shop, id)
  if (r.error) return c.redirect(`/dashboard/bookings/${id}/edit${r.busy ? '?err=busy' : ''}`)

  await db.prepare(`UPDATE bookings SET service_id=?, staff_id=?, customer_name=?, customer_email=?, customer_phone=?,
    start_time=?, end_time=?, price_cents=?, service_name=?, staff_name=?, notes=?, client_id=?, requested_staff=? WHERE id=?`)
    .bind(r.serviceId, r.staff.id, r.customerName, r.email, r.phone,
      r.startUnix, r.endUnix, r.priceCents, r.serviceName, r.staff.name, r.notes, r.clientId, r.requested, id).run()

  // If it was moved to a new time, email the customer that it was rescheduled.
  if (r.email && r.startUnix !== b.start_time) {
    const p = sendRescheduleEmail(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
  }
  return c.redirect(`/dashboard/roster?week=${rosterWeekOf(r.date)}`)
})

// ─── Take payment: QR / link the customer scans to pay (card / Apple / Google) ─
// What's already been collected for a booking (paid deposit + any QR payments).
const collectedCents = (b) => ((b.stripe_charge_id && !b.refunded_at) ? (b.deposit_cents || 0) : 0) + (b.paid_cents || 0)

app.get('/bookings/:id/pay', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(c.req.param('id'), shop.id).first()
  if (!b) return c.redirect('/dashboard/bookings')
  const connected = c.env.STRIPE_SECRET_KEY && shop.stripe_account_id && shop.stripe_charges_enabled
  const paid = collectedCents(b), remaining = Math.max(0, (b.price_cents || 0) - paid)
  const cur = shop.currency
  if (!connected) {
    return shell(c, 'bookings', 'Take payment', `
      <a href="/dashboard/bookings/${b.id}/edit" class="muted">← Back to booking</a>
      <h2>💳 Take payment</h2>
      <div class="notice err">Connect your Stripe account first (Settings → 💳 Payments) to take card payments. Until then you can only record cash on the <a href="/dashboard/day-sheet">day sheet</a>.</div>`)
  }
  return shell(c, 'bookings', 'Take payment', `
    <a href="/dashboard/bookings/${b.id}/edit" class="muted">← Back to booking</a>
    <h2>💳 Take payment</h2>
    <div class="card" style="padding:20px;max-width:460px">
      <div class="muted" style="margin-bottom:4px">${esc(b.customer_name)} · ${esc(b.service_name || '')}</div>
      <div class="muted" style="font-size:.85rem;margin-bottom:14px">${formatBookingTime(b.start_time, shop.timezone)}</div>
      <table style="width:100%;font-size:.9rem;margin-bottom:14px">
        <tr><td class="muted">Price</td><td style="text-align:right">${money(b.price_cents || 0, cur)}</td></tr>
        ${paid ? `<tr><td class="muted">Already paid</td><td style="text-align:right">− ${money(paid, cur)}</td></tr>` : ''}
        <tr><td style="font-weight:600;padding-top:6px">Remaining</td><td style="text-align:right;font-weight:600;padding-top:6px">${money(remaining, cur)}</td></tr>
      </table>
      <form method="post" action="/dashboard/bookings/${b.id}/pay">
        <div class="field"><label>Amount to charge (${cur.toUpperCase()})</label>
          <input type="number" name="amount" min="1" step="0.01" value="${((remaining || b.price_cents || 0) / 100).toFixed(2)}" required style="max-width:180px"></div>
        <button class="btn">Generate payment QR →</button>
      </form>
      <p class="muted" style="font-size:.8rem;margin:12px 0 0">The customer scans the QR (or you text them the link) and pays by card, Apple Pay or Google Pay. Alisa keeps a 1% fee; the rest goes to your Stripe.</p>
    </div>`)
})

app.post('/bookings/:id/pay', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), id = c.req.param('id')
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(id, shop.id).first()
  if (!b) return c.redirect('/dashboard/bookings')
  if (!(c.env.STRIPE_SECRET_KEY && shop.stripe_account_id && shop.stripe_charges_enabled)) return c.redirect(`/dashboard/bookings/${id}/pay`)
  const f = await c.req.parseBody()
  const amount = Math.round(parseFloat((f.amount || '').toString()) * 100)
  if (!amount || amount < 50) return c.redirect(`/dashboard/bookings/${id}/pay`)
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
  const fee = Math.max(0, Math.round(amount * 0.01))
  const paidBefore = collectedCents(b)
  try {
    const session = await stripeClient(c.env.STRIPE_SECRET_KEY).createCheckoutSession({
      mode: 'payment',
      success_url: `${base}/pay/thanks`,
      cancel_url: `${base}/pay/thanks?cancelled=1`,
      line_items: [{ quantity: 1, price_data: { currency: shop.currency, unit_amount: amount, product_data: { name: `${b.service_name || 'Appointment'} — ${shop.name}`, description: `${b.customer_name} · ${formatBookingTime(b.start_time, shop.timezone)}` } } }],
      payment_intent_data: fee > 0 ? { application_fee_amount: fee } : undefined,
      metadata: { booking_id: id, kind: 'balance' },
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }, { account: shop.stripe_account_id })
    const url = session.url
    return shell(c, 'bookings', 'Take payment', `
      <a href="/dashboard/bookings/${id}/edit" class="muted">← Back to booking</a>
      <h2>💳 Scan to pay ${money(amount, shop.currency)}</h2>
      <div class="card" style="padding:22px;max-width:420px;text-align:center">
        <div id="paybox">
          <div style="background:#fff;display:inline-block;padding:10px;border:1px solid var(--line);border-radius:12px">${qrSvg(url)}</div>
          <p class="muted" style="font-size:.85rem;margin:12px 0 6px">${esc(b.customer_name)} scans this with their phone camera and pays by card, Apple Pay or Google Pay.</p>
          <div class="inline" style="justify-content:center;gap:8px;flex-wrap:wrap">
            <a class="btn ghost sm" href="${esc(url)}" target="_blank">Open link</a>
            <button type="button" class="btn ghost sm" onclick="navigator.clipboard.writeText('${esc(url)}');this.textContent='Copied ✓'">Copy link</button>
          </div>
        </div>
        <div id="paid" style="display:none"><div style="font-size:2.4rem">✅</div><h3 style="margin:.2em 0">Paid!</h3><a class="btn sm" href="/dashboard/bookings/${id}/edit">Back to booking</a></div>
      </div>
      <script>
        var base=${paidBefore};
        var t=setInterval(async function(){
          try{ var r=await fetch('/dashboard/bookings/${id}/pay-status'); var j=await r.json();
            if(j.collected>base){ clearInterval(t); document.getElementById('paybox').style.display='none'; document.getElementById('paid').style.display='block'; } }catch(e){}
        }, 3000);
      </script>`)
  } catch (e) { console.error('pay session failed:', e.message); return c.redirect(`/dashboard/bookings/${id}/pay`) }
})

app.get('/bookings/:id/pay-status', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const b = await db.prepare('SELECT price_cents, deposit_cents, paid_cents, stripe_charge_id, refunded_at FROM bookings WHERE id=? AND shop_id=?').bind(c.req.param('id'), shop.id).first()
  if (!b) return c.json({ collected: 0 })
  const collected = collectedCents(b)
  return c.json({ collected, remaining: Math.max(0, (b.price_cents || 0) - collected) })
})

// ─── Group / couples booking ─────────────────────────────────────────────────
const GUEST_ROWS = 6
function guestRow(i, staff, services) {
  return `<div class="guestrow card" style="padding:14px 16px;margin-bottom:10px;${i < 2 ? '' : 'display:none'}">
    <div class="inline" style="justify-content:space-between"><strong>Guest ${i + 1}</strong>${i >= 2 ? `<button type="button" class="btn ghost sm rmguest">Remove</button>` : ''}</div>
    <div class="row" style="margin-top:8px">
      <div class="field"><label>Name</label><input name="guest_name_${i}" placeholder="Walk-in"></div>
      <div class="field"><label>Phone <span class="muted">(optional)</span></label><input name="guest_phone_${i}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Service</label><select name="guest_service_${i}" class="gsvc"><option value="">— none —</option>${services.map(s => `<option value="${s.id}" data-dur="${s.duration_minutes}">${esc(s.name)} · ${s.duration_minutes}min</option>`).join('')}</select></div>
      <div class="field"><label>Therapist</label><select name="guest_staff_${i}"><option value="any">✨ Any available</option>${staff.map(s => `<option value="${s.id}">${esc(s.emoji)} ${esc(s.name)}</option>`).join('')}</select></div>
    </div>
    <div class="muted gtime" style="font-size:.82rem;margin-top:2px"></div>
  </div>`
}

app.get('/bookings/group/new', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const date = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('date') || '') ? c.req.query('date') : dateTzString(new Date(), shop.timezone)
  const staff = (await db.prepare('SELECT id,name,emoji FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const services = (await db.prepare('SELECT id,name,duration_minutes FROM services WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  if (!staff.length || !services.length) return shell(c, 'bookings', 'Group booking', `<h2>Group / couples booking</h2><p class="muted">Add at least one <a href="/dashboard/staff">therapist</a> and one <a href="/dashboard/services">service</a> first.</p>`)
  const rooms = ((await db.prepare("SELECT DISTINCT room FROM bookings WHERE shop_id=? AND room IS NOT NULL AND room<>'' ORDER BY room").bind(shop.id).all()).results || []).map(r => r.room)

  return shell(c, 'bookings', 'Group booking', `
    <a href="/dashboard/roster" class="muted">← Back to roster</a>
    <h2>👥 Group / couples booking</h2>
    <p class="muted" style="margin-top:-6px">Book two or more people into the same time slot (e.g. a couples massage). Each guest gets their own service &amp; therapist; they’re linked as a group and can share a room.</p>
    <form method="post" action="/dashboard/bookings/group/new" style="max-width:640px">
      <div class="card" style="padding:18px;margin-bottom:14px">
        <div class="row">
          <div class="field"><label>Date</label><input type="date" name="date" id="gdate" value="${date}" required></div>
          <div class="field"><label>Start time <span class="muted">(available only)</span></label><select name="start" id="gstart" required><option value="">Pick a date…</option></select></div>
          <div class="field"><label>Room <span class="muted">(optional)</span></label><input name="room" list="roomlist" placeholder="e.g. Couple Room 1"><datalist id="roomlist">${rooms.map(r => `<option value="${esc(r)}">`).join('')}</datalist></div>
        </div>
      </div>
      ${Array.from({ length: GUEST_ROWS }, (_, i) => guestRow(i, staff, services)).join('')}
      <button type="button" class="btn ghost sm" id="addguest">＋ Add another guest</button>
      <div style="margin-top:16px"><button class="btn">Create group booking</button></div>
    </form>
    <script>
    var rows=[].slice.call(document.querySelectorAll('.guestrow'));
    document.getElementById('addguest').addEventListener('click',function(){for(var i=0;i<rows.length;i++){if(rows[i].style.display==='none'){rows[i].style.display='';break;}}});
    document.querySelectorAll('.rmguest').forEach(function(b){b.addEventListener('click',function(){var row=b.closest('.guestrow');row.style.display='none';row.querySelectorAll('input').forEach(function(el){el.value='';});row.querySelectorAll('select').forEach(function(el){el.selectedIndex=0;});updTimes();});});
    // Load only available start times for the chosen date.
    var dateEl=document.getElementById('gdate'), startEl=document.getElementById('gstart');
    async function loadSlots(){ if(!dateEl.value){return;} startEl.innerHTML='<option value="">Loading…</option>';
      try{ var r=await fetch('/dashboard/group-slots?date='+encodeURIComponent(dateEl.value)); var j=await r.json();
        if(!j.slots||!j.slots.length){ startEl.innerHTML='<option value="">No times available that day</option>'; updTimes(); return; }
        startEl.innerHTML='<option value="">— select a time —</option>'+j.slots.map(function(s){return '<option value="'+s.hm+'">'+s.display+' · '+s.free+' free</option>';}).join('');
      }catch(e){ startEl.innerHTML='<option value="">Could not load times</option>'; }
      updTimes();
    }
    dateEl.addEventListener('change',loadSlots);
    // Show each guest's time (shared start + their service duration).
    function fmt(m){return (''+Math.floor(m/60)).padStart(2,'0')+':'+(''+(m%60)).padStart(2,'0');}
    function updTimes(){var v=startEl&&startEl.value?startEl.value.split(':').map(Number):null;if(!v)return;var sm=v[0]*60+v[1];
      rows.forEach(function(row){var sel=row.querySelector('.gsvc'),o=sel&&sel.selectedOptions[0],d=o&&o.dataset.dur?+o.dataset.dur:0,g=row.querySelector('.gtime');
        if(g)g.textContent=d?('🕐 '+fmt(sm)+'–'+fmt(Math.min(sm+d,1439))+' · '+d+' min'):'';});}
    startEl.addEventListener('change',updTimes);
    document.querySelectorAll('.gsvc').forEach(function(s){s.addEventListener('change',updTimes);});
    loadSlots();
    </script>
  `)
})

app.post('/bookings/group/new', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const f = await c.req.parseBody()
  const date = (f.date || '').toString(), start = (f.start || '').toString()
  const room = (f.room || '').toString().trim() || null
  const back = `/dashboard/bookings/group/new${date ? `?date=${date}` : ''}`
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(start)) return c.redirect(back)
  const startUnix = Math.floor(localToUtcMs(date, start, shop.timezone) / 1000)
  const groupId = genId()
  const usedIds = new Set()
  let made = 0
  for (let i = 0; i < GUEST_ROWS; i++) {
    const sid = (f[`guest_service_${i}`] || '').toString()
    if (!sid) continue
    const svc = await db.prepare('SELECT * FROM services WHERE id=? AND shop_id=? AND is_active=1').bind(sid, shop.id).first()
    if (!svc) continue
    const endUnix = startUnix + svc.duration_minutes * 60
    // Therapist: a specific one, or "any available" → assign a free eligible one
    // that isn't already used elsewhere in this group.
    const staffId = (f[`guest_staff_${i}`] || '').toString()
    let stf = null
    if (staffId && staffId !== 'any') {
      const cand = await db.prepare('SELECT id,name FROM staff WHERE id=? AND shop_id=?').bind(staffId, shop.id).first()
      if (cand && !usedIds.has(cand.id) && await therapistFreeAt(db, cand.id, startUnix, endUnix)) stf = cand
    }
    if (!stf) stf = await freeTherapist(db, shop, svc, startUnix, endUnix, usedIds)  // any free, no overlaps
    if (!stf) continue
    usedIds.add(stf.id)
    const name = (f[`guest_name_${i}`] || '').toString().trim() || 'Walk-in'
    const phone = (f[`guest_phone_${i}`] || '').toString().trim()
    const clientId = await findOrCreateClient(db, shop.id, { name, phone })
    await db.prepare(`INSERT INTO bookings
      (id, shop_id, service_id, staff_id, customer_name, customer_email, customer_phone,
       start_time, end_time, status, price_cents, deposit_cents, service_name, staff_name, lang, client_id, group_id, room)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'confirmed', ?, 0, ?, ?, 'en', ?, ?, ?)`)
      .bind(genId(), shop.id, svc.id, stf.id, name, phone, startUnix, endUnix, svc.price_cents, svc.name, stf.name, clientId, groupId, room).run()
    made++
  }
  if (!made) return c.redirect(back)
  return c.redirect(`/dashboard/roster?view=day&date=${date}`)
})

// Available group start times for a date: times (at the slot interval, within
// working hours) where at least one therapist is free. Returns the free count too.
app.get('/group-slots', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), tz = shop.timezone
  const date = c.req.query('date') || ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ slots: [] })
  const interval = Math.max(5, Number(shop.slot_interval_minutes) || 15)
  const dow = new Date(date + 'T12:00:00Z').getUTCDay()
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  const pad = n => String(n).padStart(2, '0')
  const hm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
  const disp = m => { const h = Math.floor(m / 60); return `${(h % 12) || 12}:${pad(m % 60)} ${h < 12 ? 'AM' : 'PM'}` }

  const avails = (await db.prepare('SELECT a.staff_id,a.start_time,a.end_time FROM availability a JOIN staff s ON s.id=a.staff_id WHERE s.shop_id=? AND s.is_active=1 AND a.day_of_week=?').bind(shop.id, dow).all()).results || []
  const offIds = new Set(((await db.prepare('SELECT t.staff_id FROM time_off t JOIN staff s ON s.id=t.staff_id WHERE s.shop_id=? AND t.date=?').bind(shop.id, date).all()).results || []).map(o => o.staff_id))
  // Constrain to the shop's opening hours for this weekday (closed → no windows).
  const sh = shopHoursFor(shop, dow)
  if (sh === null) return c.json({ slots: [] })
  const clampS = sh ? toMin(sh.open) : 0, clampE = sh ? toMin(sh.close) : 24 * 60
  const windows = avails.filter(a => !offIds.has(a.staff_id))
    .map(a => ({ staff: a.staff_id, s: Math.max(toMin(a.start_time), clampS), e: Math.min(toMin(a.end_time), clampE) }))
    .filter(w => w.e > w.s)
  if (!windows.length) return c.json({ slots: [] })
  const dayStart = Math.min(...windows.map(w => w.s)), dayEnd = Math.max(...windows.map(w => w.e))

  const dayStartU = Math.floor(localToUtcMs(date, '00:00', tz) / 1000)
  const booked = (await db.prepare("SELECT staff_id,start_time,end_time FROM bookings WHERE shop_id=? AND start_time>=? AND start_time<? AND status IN ('pending_payment','confirmed','completed')").bind(shop.id, dayStartU, dayStartU + 86400).all()).results || []
  const bookedByStaff = {}; for (const b of booked) (bookedByStaff[b.staff_id] ||= []).push(b)

  const now = Math.floor(Date.now() / 1000) + 30 * 60   // 30-min lead
  const slots = []
  for (let m = dayStart; m + interval <= dayEnd; m += interval) {
    const startU = Math.floor(localToUtcMs(date, hm(m), tz) / 1000)
    if (startU < now) continue
    const endU = startU + interval * 60
    let free = 0
    for (const w of windows) {
      if (m < w.s || m >= w.e) continue
      const conflict = (bookedByStaff[w.staff] || []).some(b => b.start_time < endU && b.end_time > startU)
      if (!conflict) free++
    }
    if (free >= 1) slots.push({ hm: hm(m), display: disp(m), free })
  }
  return c.json({ slots })
})

// Available start times for the "Add booking" form (specific therapist or any).
app.get('/avail-times', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const date = (c.req.query('date') || '').toString()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ times: [] })
  const staff = (c.req.query('staff') || 'any').toString()
  const serviceId = (c.req.query('service') || '').toString()
  let dur = 60
  if (serviceId) { const sv = await db.prepare('SELECT duration_minutes FROM services WHERE id=? AND shop_id=?').bind(serviceId, shop.id).first(); if (sv) dur = sv.duration_minutes }
  return c.json({ times: await availStartTimes(db, shop, date, staff, dur, serviceId) })
})

// ─── Day reconciliation sheet (printable) ────────────────────────────────────
// A printable end-of-day cash-up sheet in the style of a paper massage-shop
// ledger: one row per booking (time · service · price), a column per therapist,
// and the cash/credit/staff totals to reconcile the till by hand.
app.get('/day-sheet', async (c) => {
  const db = c.env.DB, shop = c.get('shop'), tz = shop.timezone
  const today = dateTzString(new Date(), tz)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('date') || '') ? c.req.query('date') : today

  const staff = (await db.prepare('SELECT id,name FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const dayStartU = Math.floor(localToUtcMs(date, '00:00', tz) / 1000)
  const bookings = (await db.prepare("SELECT * FROM bookings WHERE shop_id=? AND start_time>=? AND start_time<? AND status!='cancelled' ORDER BY start_time")
    .bind(shop.id, dayStartU, dayStartU + 86400).all()).results || []

  // Therapist columns (pad to at least 4 blanks; cap at 6 to fit the page).
  let cols = staff.slice(0, 6).map(s => ({ id: s.id, name: s.name }))
  while (cols.length < 4) cols.push({ id: null, name: '' })
  const nStaff = cols.length

  const amt = cents => { const v = (cents || 0) / 100; return v ? v.toFixed(2).replace(/\.00$/, '') : '' }
  const clk = u => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(u * 1000))
  const durLabel = (s, e) => { const m = Math.round((e - s) / 60); return m % 60 === 0 ? `${m / 60} hr` : `${m} mins` }

  const heading = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long' })
  const dispDate = new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'numeric', year: '2-digit' })
  const ROWS = Math.max(30, bookings.length)

  // Saved manual entries (cash, commissions, change…) keyed by cell.
  const savedRow = await db.prepare('SELECT data FROM day_sheets WHERE shop_id=? AND date=?').bind(shop.id, date).first()
  let saved = {}; if (savedRow) { try { saved = JSON.parse(savedRow.data) || {} } catch { saved = {} } }

  // Editable cell. calc = auto-computed (read-only); everything else is typed.
  const cell = (k, val = '', { calc = false, num = true, ph = '' } = {}) =>
    `<input data-k="${k}" value="${esc(val)}"${calc ? ' readonly tabindex="-1"' : ''} class="c${num ? ' num' : ' tl'}${calc ? ' calc' : ''}"${ph ? ` placeholder="${esc(ph)}"` : ''}${calc ? '' : ' inputmode="' + (num ? 'decimal' : 'text') + '"'}>`
  const fillin = (k, calc = false, strong = false) => `<input data-k="${k}"${calc ? ' readonly tabindex="-1"' : ''} class="fillin${calc ? ' calc' : ''}${strong ? ' b' : ''}" inputmode="decimal">`

  const fixed = { job: 4, time: 12, svc: 19, full: 8, cs: 6, cr: 7, tf: 6, rem: 10 }
  const staffW = Math.max(4, Math.round((100 - Object.values(fixed).reduce((a, b) => a + b, 0)) / nStaff))

  const headCells =
    `<th style="width:${fixed.job}%">JOB</th><th style="width:${fixed.time}%">TIME</th><th style="width:${fixed.svc}%">SERVICE</th>` +
    `<th style="width:${fixed.full}%">FULL<br>PRICE</th><th style="width:${fixed.cs}%">CS</th><th style="width:${fixed.cr}%">CR</th><th style="width:${fixed.tf}%">TF</th>` +
    cols.map((cc, i) => `<th style="width:${staffW}%">${esc((cc.name || '').split(' ')[0].toUpperCase())}${cc.name ? `<sup>${i + 1}</sup>` : ''}</th>`).join('') +
    `<th style="width:${fixed.rem}%">REMARK</th>`

  const rowsHtml = Array.from({ length: ROWS }, (_, i) => {
    const b = bookings[i]
    const ci = b ? cols.findIndex(cc => cc.id === b.staff_id) : -1
    const staffCells = cols.map((cc, j) => `<td class="${b && j === ci ? 'assigned' : ''}">${cell(`r${i}_s${j}`, '', { ph: b && j === ci ? (cc.name || '').slice(0, 1).toUpperCase() : '' })}</td>`).join('')
    return `<tr>
      <td class="job">${i + 1}</td>
      <td>${cell(`r${i}_time`, b ? `${clk(b.start_time)}–${clk(b.end_time)}` : '', { num: false })}</td>
      <td>${cell(`r${i}_svc`, b ? `${b.service_name || ''} · ${durLabel(b.start_time, b.end_time)}` : '', { num: false })}</td>
      <td>${cell(`r${i}_full`, b ? amt(b.price_cents) : '')}</td>
      <td>${cell(`r${i}_cs`)}</td><td>${cell(`r${i}_cr`)}</td><td>${cell(`r${i}_tf`)}</td>
      ${staffCells}
      <td>${cell(`r${i}_rem`, '', { num: false })}</td>
    </tr>`
  }).join('')

  const totalRow = `<tr class="tot">
    <td></td><td></td><td class="rt">TOTAL</td>
    <td>${cell('tot_full', '', { calc: true })}</td><td>${cell('tot_cs', '', { calc: true })}</td><td>${cell('tot_cr', '', { calc: true })}</td><td>${cell('tot_tf', '', { calc: true })}</td>
    ${cols.map(() => '<td></td>').join('')}<td></td></tr>`
  const staffRow = (label, prefix, calc) => `<tr class="tot">
    <td colspan="7" class="rt">${label}</td>
    ${cols.map((_, j) => `<td>${cell(`${prefix}_${j}`, '', { calc })}</td>`).join('')}<td></td></tr>`

  const css = `
    :root{--accent:${shop.accent}}
    body{background:#f4f2ee}
    .bar{max-width:900px;margin:14px auto 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:0 12px}
    .bar input[type=date]{padding:8px 10px;border:1px solid #ccc;border-radius:8px;font:inherit;max-width:180px}
    #savestatus{font-size:.82rem;color:var(--muted)}
    .sheet{max-width:900px;margin:12px auto 40px;background:#fff;color:#000;padding:14px 16px;box-shadow:0 1px 6px rgba(0,0,0,.12)}
    .shead{display:flex;align-items:stretch;border:1.5px solid #000;border-bottom:none}
    .shead .nm{background:#111;color:#fff;font-weight:700;letter-spacing:.03em;padding:7px 10px;font-size:12px;display:flex;align-items:center;white-space:nowrap}
    .shead .day{flex:1;text-align:center;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;border-left:1.5px solid #000}
    .shead .meta{padding:6px 10px;font-size:11px;border-left:1.5px solid #000;display:flex;align-items:center;gap:8px;white-space:nowrap}
    .shead .meta input{width:8ch;border:none;border-bottom:1px solid #000;font:inherit;font-size:11px;text-align:center;background:transparent}
    table.rs{border-collapse:collapse;width:100%;table-layout:fixed}
    table.rs th,table.rs td{border:1px solid #000;padding:0;font-size:9.5px;line-height:1.2;height:18px;overflow:hidden;text-align:center;vertical-align:middle}
    table.rs th{background:#eee;font-size:8.5px;font-weight:700;padding:1px 2px}
    table.rs td.job{font-size:8px;color:#333}
    table.rs td.assigned{background:#eaf3f1}
    table.rs td.rt,table.rs td[colspan]{text-align:right;font-weight:700;font-size:8.5px;padding:0 4px}
    table.rs tr.tot td{height:20px;background:#f6f6f6}
    input.c{width:100%;height:100%;border:none;border-radius:0;-webkit-appearance:none;appearance:none;background:transparent;font:inherit;font-size:9.5px;padding:0 3px;text-align:center;color:#000}
    input.c.num{text-align:right}
    input.c.tl{text-align:left}
    input.c.calc{font-weight:700;background:#f0efe9}
    input.c:focus{outline:2px solid var(--accent);outline-offset:-2px;background:#fffef8}
    sup{font-size:7px}
    .recon{border:1.5px solid #000;border-top:none;padding:10px 10px 12px;font-size:11px}
    .rline{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-bottom:10px}
    .rline:last-child{margin-bottom:0}
    .rline span{white-space:nowrap;display:inline-flex;align-items:center}
    .fillin{display:inline-block;border:none;border-bottom:1px solid #000;border-radius:0;-webkit-appearance:none;appearance:none;width:58px;height:20px;line-height:20px;box-sizing:border-box;font:inherit;font-size:11px;text-align:center;background:transparent;margin:0 2px 0 4px;color:#000;vertical-align:middle}
    .fillin.b{font-weight:700}
    .fillin.calc{background:#f0efe9}
    .fillin:focus,.shead .meta input:focus{outline:none;background:#fffef8}
    @media print{ .noprint,footer{display:none!important} body{background:#fff} .sheet{box-shadow:none;margin:0;max-width:none;padding:0}
      input.c.calc,.fillin.calc,table.rs th,table.rs tr.tot td,table.rs td.assigned{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      input.c.calc,.fillin.calc{background:transparent!important} @page{size:A4 portrait;margin:8mm} }
  `

  const bootstrap = `<script>
    window.__DS={ date:${JSON.stringify(date)}, rows:${ROWS}, cols:${nStaff}, saved:${JSON.stringify(saved).replace(/</g, '\\u003c')} };
  </script>`

  return c.html(layout('Day sheet', `${bootstrap}
    <div class="bar noprint">
      <a class="btn ghost sm" href="/dashboard/roster?view=day&date=${date}">← Roster</a>
      <input type="date" value="${date}" onchange="if(this.value)location.href='/dashboard/day-sheet?date='+this.value" aria-label="Day sheet date">
      <button class="btn sm" id="savebtn">💾 Save</button>
      <button class="btn ghost sm" onclick="window.print()">🖨️ Print / PDF</button>
      <span id="savestatus"></span>
      <form method="post" action="/dashboard/day-sheet/reset" style="margin:0" onsubmit="return confirm('Clear your saved entries for this day and reload from the calendar?')"><input type="hidden" name="date" value="${date}"><button class="btn ghost sm" type="submit" style="color:var(--danger)">↻ Reset</button></form>
    </div>
    <p class="bar noprint muted" style="margin-top:2px;font-size:.82rem;padding-top:0">Type in any cell — cash (CS), card (CR), transfers (TF), staff pay, change. Grey cells total automatically. Edits save as you type.</p>
    <div class="sheet">
      <div class="shead">
        <div class="nm">${esc(shop.emoji || '')} ${esc(shop.name.toUpperCase())}</div>
        <div class="day">${heading}</div>
        <div class="meta"><span>DATE ${dispDate}</span><span>CHANGE ${fillin('hdr_change').replace('class="fillin"', 'class="fillin" style="width:7ch"')}</span></div>
      </div>
      <table class="rs">
        <thead><tr>${headCells}</tr></thead>
        <tbody>
          ${rowsHtml}
          ${totalRow}
          ${staffRow('STAFF TOTAL =', 'st', true)}
          ${staffRow('STAFF CASH =', 'sc', false)}
          ${staffRow('STAFF BANK =', 'sb', false)}
        </tbody>
      </table>
      <div class="recon">
        <div class="rline">
          <span>CASH ${fillin('b_cash', true)}</span><span>+ CREDIT ${fillin('b_credit', true)}</span><span>+ TF ${fillin('b_tf', true)}</span><span>( + FS ${fillin('b_fs')} )</span>
          <span>= SHOP TOTAL ${fillin('b_shopTotal', true, true)}</span><span>− STAFF TOTAL ${fillin('b_staffTotal', true)}</span><span>= NET INCOME ${fillin('b_net', true, true)}</span>
        </div>
        <div class="rline">
          <span>CASH ${fillin('b_cash2', true)}</span><span>+ CHANGE ${fillin('b_change2', true)}</span><span>− STAFF CASH ${fillin('b_staffCash', true)}</span><span>− MISC ${fillin('b_misc')}</span>
          <span>= TOTAL ${fillin('b_total', true, true)}</span><span>( KEEP ${fillin('b_keep')} / CHANGE ${fillin('b_change3')} )</span>
        </div>
      </div>
    </div>
    <script>
    (function(){
      var D=window.__DS, ROWS=D.rows, COLS=D.cols;
      var inputs=[].slice.call(document.querySelectorAll('[data-k]'));
      var byK={}; inputs.forEach(function(el){byK[el.dataset.k]=el;});
      function num(k){var el=byK[k];return el?(parseFloat(el.value)||0):0;}
      function fmt(v){ if(!v) return ''; return String(Math.round(v*100)/100); }
      function setC(k,v){ if(byK[k]) byK[k].value=fmt(v); }
      // Apply saved manual entries.
      Object.keys(D.saved||{}).forEach(function(k){ if(byK[k]&&!byK[k].classList.contains('calc')) byK[k].value=D.saved[k]; });
      function calc(){
        var tf=0,tcs=0,tcr=0,ttf=0;
        for(var i=0;i<ROWS;i++){ tf+=num('r'+i+'_full'); tcs+=num('r'+i+'_cs'); tcr+=num('r'+i+'_cr'); ttf+=num('r'+i+'_tf'); }
        setC('tot_full',tf);setC('tot_cs',tcs);setC('tot_cr',tcr);setC('tot_tf',ttf);
        var stTotal=0, scTotal=0;
        for(var j=0;j<COLS;j++){ var s=0; for(var r=0;r<ROWS;r++) s+=num('r'+r+'_s'+j); setC('st_'+j,s); stTotal+=s; scTotal+=num('sc_'+j); }
        setC('b_cash',tcs);setC('b_credit',tcr);setC('b_tf',ttf);setC('b_shopTotal',tf);
        setC('b_staffTotal',stTotal); setC('b_net', tf-stTotal);
        setC('b_cash2',tcs); setC('b_change2', num('hdr_change')); setC('b_staffCash',scTotal);
        setC('b_total', tcs + num('hdr_change') - scTotal - num('b_misc'));
      }
      var timer=null, status=document.getElementById('savestatus');
      function schedule(){ if(timer)clearTimeout(timer); if(status)status.textContent='Saving…'; timer=setTimeout(save,700); }
      async function save(){
        var data={}; inputs.forEach(function(el){ if(!el.classList.contains('calc')&&el.value!=='') data[el.dataset.k]=el.value; });
        try{ var r=await fetch('/dashboard/day-sheet/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:D.date,data:data})});
          if(status)status.textContent=r.ok?'Saved ✓':'Save failed'; }catch(e){ if(status)status.textContent='Save failed'; }
      }
      inputs.forEach(function(el){ if(!el.classList.contains('calc')) el.addEventListener('input',function(){calc();schedule();}); });
      var sb=document.getElementById('savebtn'); if(sb)sb.addEventListener('click',function(){calc();save();});
      calc();
    })();
    </script>
  `, { lang: c.get('lang'), css }))
})

// Save an editable day sheet (manual cash/commission entries).
app.post('/day-sheet/save', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  let body; try { body = await c.req.json() } catch { return c.json({ error: 'bad json' }, 400) }
  const date = (body.date || '').toString()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'bad date' }, 400)
  const data = JSON.stringify(body.data && typeof body.data === 'object' ? body.data : {})
  if (data.length > 60000) return c.json({ error: 'too large' }, 413)
  await db.prepare('INSERT INTO day_sheets (shop_id,date,data,updated_at) VALUES (?,?,?,unixepoch()) ON CONFLICT(shop_id,date) DO UPDATE SET data=excluded.data, updated_at=unixepoch()')
    .bind(shop.id, date, data).run()
  return c.json({ ok: true })
})

// Discard saved entries for a day and reload fresh from the calendar.
app.post('/day-sheet/reset', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const f = await c.req.parseBody()
  const date = (f.date || '').toString()
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) await db.prepare('DELETE FROM day_sheets WHERE shop_id=? AND date=?').bind(shop.id, date).run()
  return c.redirect(`/dashboard/day-sheet?date=${/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''}`)
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
    // Email them their scheduling link + a prompt to create an account.
    const p = sendTherapistInvite(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
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
  const st = await db.prepare('SELECT id, email FROM staff WHERE id = ? AND shop_id = ?').bind(id, shop.id).first()
  if (!st) return c.redirect('/dashboard/staff')
  const email = ((await c.req.parseBody()).email || '').toString().trim().toLowerCase()
  // Re-link to a matching therapist account if one exists (else leave unlinked
  // until the therapist signs up with this email).
  const th = email ? await db.prepare('SELECT id FROM therapists WHERE email = ?').bind(email).first() : null
  await db.prepare('UPDATE staff SET email = ?, therapist_id = ? WHERE id = ?').bind(email || null, th?.id || null, id).run()
  // Invite them when a new email is set (not on every resave of the same one).
  if (email && email !== (st.email || '')) {
    const p = sendTherapistInvite(c.env, id)
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
  }
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
  const tiers = await getTiers(c.env.DB, shop.id)
  const TIER_ROWS = 8
  const tierRow = (i, t) => `<tr class="tierrow" style="${i < Math.max(tiers.length + 1, 2) ? '' : 'display:none'}">
    <td><input type="number" name="tier_visits_${i}" value="${t ? t.visits : ''}" min="1" placeholder="5" style="max-width:90px"></td>
    <td><select name="tier_type_${i}"><option value="amount" ${t && t.type === 'percent' ? '' : 'selected'}>Amount off</option><option value="percent" ${t && t.type === 'percent' ? 'selected' : ''}>% off</option></select></td>
    <td><input type="number" name="tier_value_${i}" value="${t ? (t.type === 'percent' ? t.value : t.value / 100) : ''}" min="0" step="1" placeholder="20" style="max-width:100px"></td>
    <td><button type="button" class="btn ghost sm rmtier">✕</button></td></tr>`
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
        <h3 style="margin-top:0">💳 Payments</h3>
        ${c.req.query('psaved') ? '<div class="notice ok" style="margin-bottom:10px">Stripe status updated.</div>' : ''}
        ${c.req.query('perr') ? `<div class="notice err" style="margin-bottom:10px"><strong>Couldn’t start Stripe:</strong> ${esc(decodeURIComponent(c.req.query('perr')).slice(0, 300))}<br><span style="font-size:.85em">If this mentions Connect not being enabled, the platform owner needs to enable Connect (Express) in the Stripe dashboard first.</span></div>` : ''}
        ${(() => {
          const platform = !!c.env.STRIPE_SECRET_KEY
          const acct = shop.stripe_account_id, active = acct && shop.stripe_charges_enabled, started = acct && !shop.stripe_charges_enabled
          if (!platform) return `<p class="muted" style="margin:0">Online card deposits aren’t switched on for this platform yet, so bookings are taken <strong>without a deposit</strong> — perfect for testing. When Stripe is enabled you’ll be able to connect your account here.</p>`
          if (active) return `<p style="margin:.2em 0"><span class="tag completed">✓ Connected</span> Deposits are on. Alisa keeps a <strong>1% platform fee</strong> on each deposit; the rest is paid straight into your own Stripe account.</p>
            <div class="inline"><a class="btn ghost sm" href="/dashboard/payments/dashboard" target="_blank">Open Stripe dashboard →</a></div>`
          if (started) return `<p style="margin:.2em 0"><span class="tag pending_payment">Setup incomplete</span> You started connecting Stripe but haven’t finished — deposits stay off until it’s done.</p>
            <button type="submit" formaction="/dashboard/payments/connect" formmethod="post" formnovalidate class="btn sm">Finish Stripe setup →</button>`
          return `<p style="margin:.2em 0">Connect your Stripe account to collect booking deposits. Alisa keeps a <strong>1% platform fee</strong> per deposit; everything else goes straight to you. Until you connect, bookings are taken <strong>without a deposit</strong> (handy for testing).</p>
            <button type="submit" formaction="/dashboard/payments/connect" formmethod="post" formnovalidate class="btn sm">Connect Stripe →</button>`
        })()}
        <p class="muted" style="font-size:.82rem;margin:12px 0 0">The deposit <em>amount</em> is set by <strong>Deposit (% of price)</strong> below — set it to 0% to skip deposits even when connected.</p>
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
      <div class="card" style="padding:22px;margin-bottom:18px">
        <h3 style="margin-top:0">🕑 Opening hours</h3>
        <p class="muted" style="font-size:.82rem;margin:0 0 12px">When the shop is open. Bookings — online, group and roster — are only ever offered inside these hours. Untick a day to mark it closed. (Each therapist can still have shorter hours within these.)</p>
        ${(() => {
          let hrs = {}; try { hrs = shop.hours_json ? JSON.parse(shop.hours_json) : {} } catch { hrs = {} }
          const configured = shop.hours_json != null
          const days = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']]
          return days.map(([d, label]) => {
            const v = hrs[d] ?? hrs[String(d)]
            // Default (never configured): open 9–6 Mon–Sat, Sunday closed.
            const open = v ? v[0] : (configured ? '' : '09:00')
            const close = v ? v[1] : (configured ? '' : '18:00')
            const isOpen = v ? true : (configured ? false : d !== 0)
            return `<div class="inline hrrow" data-d="${d}" style="gap:10px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:7px;font-weight:400;min-width:132px;cursor:pointer"><input type="checkbox" class="hropen" name="hours_open_${d}" value="1" style="width:auto" ${isOpen ? 'checked' : ''}> <strong>${label}</strong></label>
              <span class="hrtimes" style="display:inline-flex;gap:6px;align-items:center${isOpen ? '' : ';opacity:.4'}">
                <input type="time" name="hours_from_${d}" value="${open || '09:00'}" style="max-width:130px"> <span class="muted">to</span> <input type="time" name="hours_to_${d}" value="${close || '18:00'}" style="max-width:130px">
              </span>
            </div>`
          }).join('')
        })()}
        <script>document.querySelectorAll('.hrrow').forEach(function(row){var cb=row.querySelector('.hropen'),tw=row.querySelector('.hrtimes');function sync(){tw.style.opacity=cb.checked?'':'0.4';tw.querySelectorAll('input').forEach(function(i){i.disabled=!cb.checked;});}cb.addEventListener('change',sync);sync();});</script>
      </div>
      <div class="card" style="padding:22px;margin-bottom:18px">
        <h3 style="margin-top:0">Reviews</h3>
        <div class="field"><label>Google review link</label><input name="google_review_url" value="${f('google_review_url')}" placeholder="https://g.page/r/…/review"></div>
        <p class="muted" style="font-size:.82rem;margin:0">After a visit, clients are asked for a review (kept in <a href="/dashboard/reviews">Reviews</a>). Happy clients (4–5★) are then offered this Google link. Get it from your Google Business Profile → “Ask for reviews”.</p>
      </div>
      <div class="card" style="padding:22px;margin-bottom:18px">
        <h3 style="margin-top:0">🎁 Loyalty program</h3>
        <label style="display:flex;align-items:center;gap:8px;font-weight:400;cursor:pointer"><input type="checkbox" name="loyalty_enabled" value="1" style="width:auto" ${shop.loyalty_enabled ? 'checked' : ''}> Enable loyalty rewards</label>
        <p class="muted" style="font-size:.82rem;margin:8px 0">Add reward tiers — e.g. <strong>5 visits = $20 off</strong>, <strong>10 = $50 off</strong>, <strong>20 = 100% off</strong>. Each is a one-time reward a client earns after that many completed visits.</p>
        <table id="tiertable" style="margin-bottom:10px"><tr><th>After (visits)</th><th>Reward</th><th>Value (${shop.currency.toUpperCase()} or %)</th><th></th></tr>
          ${Array.from({ length: TIER_ROWS }, (_, i) => tierRow(i, tiers[i])).join('')}
        </table>
        <button type="button" class="btn ghost sm" id="addtier">＋ Add tier</button>
        <script>
        (function(){var rows=[].slice.call(document.querySelectorAll('#tiertable .tierrow'));
          var add=document.getElementById('addtier'); if(add)add.addEventListener('click',function(){for(var i=0;i<rows.length;i++){if(rows[i].style.display==='none'){rows[i].style.display='';break;}}});
          document.querySelectorAll('#tiertable .rmtier').forEach(function(b){b.addEventListener('click',function(){var r=b.closest('.tierrow');r.style.display='none';r.querySelectorAll('input').forEach(function(el){el.value='';});});});
        })();
        </script>
      </div>
      <button class="btn">Save settings</button>
    </form>

    <div class="card" style="padding:22px;margin-top:18px;max-width:640px">
      <h3 style="margin-top:0">📤 Export your data</h3>
      <p class="muted" style="font-size:.9rem;margin:0 0 14px">Your data is <strong>yours</strong> — take it with you anytime, no lock-in. Download your clients, bookings and reviews as spreadsheets (CSV), or grab a full copy of everything as one file.</p>
      <div class="inline" style="gap:8px;flex-wrap:wrap">
        <a class="btn ghost sm" href="/dashboard/export/clients.csv">👤 Clients (CSV)</a>
        <a class="btn ghost sm" href="/dashboard/export/bookings.csv">🗓️ Bookings (CSV)</a>
        <a class="btn ghost sm" href="/dashboard/export/reviews.csv">⭐ Reviews (CSV)</a>
        <a class="btn sm" href="/dashboard/export/all.json">⬇️ Everything (JSON)</a>
      </div>
      <p class="muted" style="font-size:.78rem;margin:12px 0 0">CSV files open in Excel, Numbers or Google Sheets. Unlike some platforms, we never hold your customer list hostage.</p>
    </div>
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

  // Opening hours → { weekday: ["HH:MM","HH:MM"] }; a day is closed if unticked
  // or its times are invalid. Stored as JSON on the shop row.
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
  const hours = {}
  for (let d = 0; d <= 6; d++) {
    if (!f[`hours_open_${d}`]) continue
    const from = (f[`hours_from_${d}`] || '').toString(), to = (f[`hours_to_${d}`] || '').toString()
    if (HHMM.test(from) && HHMM.test(to) && to > from) hours[d] = [from, to]
  }
  // Store NULL (no constraint) rather than "{}" when no day is open — an empty
  // map must never silently close the whole shop.
  const hoursJson = Object.keys(hours).length ? JSON.stringify(hours) : null

  await db.prepare(`UPDATE shops SET name=?, emoji=?, tagline=?, about=?, slug=?, accent=?, phone=?, email=?,
    address=?, suburb=?, state=?, postcode=?, timezone=?, deposit_pct=?, cancellation_hours=?, slot_interval_minutes=?, hours_json=?, google_review_url=?, loyalty_enabled=? WHERE id=?`)
    .bind((f.name || shop.name).toString().trim(), (f.emoji || '💆').toString().trim() || '💆',
      (f.tagline || '').toString(), (f.about || '').toString(), slug, (f.accent || '#0f766e').toString(),
      (f.phone || '').toString(), (f.email || '').toString(), (f.address || '').toString(),
      (f.suburb || '').toString(), (f.state || '').toString(), (f.postcode || '').toString(),
      (f.timezone || shop.timezone).toString(), parseInt(f.deposit_pct) || 0, parseInt(f.cancellation_hours) || 0, interval, hoursJson, (f.google_review_url || '').toString().trim() || null,
      f.loyalty_enabled ? 1 : 0, shop.id).run()

  // Replace loyalty tiers from the form rows.
  await db.prepare('DELETE FROM loyalty_tiers WHERE shop_id=?').bind(shop.id).run()
  const seen = new Set()
  for (let i = 0; i < 8; i++) {
    const visits = parseInt(f[`tier_visits_${i}`])
    const valIn = parseFloat(f[`tier_value_${i}`])
    const type = f[`tier_type_${i}`] === 'percent' ? 'percent' : 'amount'
    if (!visits || visits < 1 || !valIn || valIn <= 0 || seen.has(visits)) continue
    const value = type === 'percent' ? Math.max(0, Math.min(100, Math.round(valIn))) : Math.max(0, Math.round(valIn * 100))
    if (value <= 0) continue
    seen.add(visits)
    await db.prepare('INSERT INTO loyalty_tiers (id, shop_id, visits, type, value) VALUES (?, ?, ?, ?, ?)').bind(genId(), shop.id, visits, type, value).run()
  }
  return c.redirect('/dashboard/settings')
})

// ─── Stripe Connect (Express) onboarding ─────────────────────────────────────
const ONBOARD_LINK = (base) => ({ refresh_url: `${base}/dashboard/payments/refresh`, return_url: `${base}/dashboard/payments/return`, type: 'account_onboarding' })

const perr = (msg) => `/dashboard/settings?perr=${encodeURIComponent(String(msg).slice(0, 300))}#pay`

app.post('/payments/connect', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  if (!c.env.STRIPE_SECRET_KEY) return c.redirect(perr('Online payments are not enabled on this platform yet (no Stripe key configured).'))
  const sc = stripeClient(c.env.STRIPE_SECRET_KEY)
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
  try {
    let acct = shop.stripe_account_id
    if (!acct) {
      const created = await sc.createAccount({
        type: 'express',
        email: shop.email || undefined,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { name: shop.name, url: `${base}/${shop.slug}`, mcc: '7298' },
        metadata: { shop_id: shop.id }
      })
      acct = created.id
      await db.prepare('UPDATE shops SET stripe_account_id=? WHERE id=?').bind(acct, shop.id).run()
    }
    const link = await sc.createAccountLink({ account: acct, ...ONBOARD_LINK(base) })
    return c.redirect(link.url)
  } catch (e) { console.error('connect failed:', e.message); return c.redirect(perr(e.message)) }
})

// Stripe bounces the owner back here after onboarding — refresh cached status.
app.get('/payments/return', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  if (c.env.STRIPE_SECRET_KEY && shop.stripe_account_id) {
    try {
      const acct = await stripeClient(c.env.STRIPE_SECRET_KEY).retrieveAccount(shop.stripe_account_id)
      await db.prepare('UPDATE shops SET stripe_charges_enabled=?, stripe_details_submitted=? WHERE id=?')
        .bind(acct.charges_enabled ? 1 : 0, acct.details_submitted ? 1 : 0, shop.id).run()
    } catch (e) { console.error('return refresh failed:', e.message) }
  }
  return c.redirect('/dashboard/settings?psaved=1')
})

// Onboarding link expired mid-flow — mint a fresh one.
app.get('/payments/refresh', async (c) => {
  const shop = c.get('shop'), base = c.env.BASE_URL || 'https://alisa.bored.investments'
  if (!c.env.STRIPE_SECRET_KEY || !shop.stripe_account_id) return c.redirect('/dashboard/settings')
  try {
    const link = await stripeClient(c.env.STRIPE_SECRET_KEY).createAccountLink({ account: shop.stripe_account_id, ...ONBOARD_LINK(base) })
    return c.redirect(link.url)
  } catch (e) { return c.redirect(perr(e.message)) }
})

// Express dashboard (payouts, etc.) via a single-use login link.
app.get('/payments/dashboard', async (c) => {
  const shop = c.get('shop')
  if (!c.env.STRIPE_SECRET_KEY || !shop.stripe_account_id) return c.redirect('/dashboard/settings')
  try {
    const link = await stripeClient(c.env.STRIPE_SECRET_KEY).createLoginLink(shop.stripe_account_id)
    return c.redirect(link.url)
  } catch (e) { return c.redirect(perr(e.message)) }
})

// ─── Reviews ─────────────────────────────────────────────────────────────────
app.get('/reviews', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const rows = (await db.prepare('SELECT * FROM reviews WHERE shop_id=? ORDER BY created_at DESC LIMIT 300').bind(shop.id).all()).results || []
  const agg = await db.prepare('SELECT COUNT(*) n, COALESCE(AVG(rating),0) avg FROM reviews WHERE shop_id=?').bind(shop.id).first()
  const stars = (n) => `<span style="color:#e6a817;letter-spacing:1px">${'★'.repeat(n)}<span style="color:#d9d2c7">${'★'.repeat(5 - n)}</span></span>`
  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
  const reviewUrl = `${base}/${shop.slug}/review`
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=12&data=${encodeURIComponent(reviewUrl)}`
  return shell(c, 'reviews', 'Reviews', `
    <h2>Reviews</h2>
    <div class="card" style="padding:22px;margin-bottom:18px">
      <h3 style="margin-top:0">⭐ Collect reviews</h3>
      <div class="inline" style="gap:22px;align-items:flex-start;flex-wrap:wrap">
        <div style="text-align:center">
          <img src="${qrUrl}" alt="Review QR code" width="180" height="180" style="border:1px solid var(--line);border-radius:12px;background:#fff;padding:6px">
          <div style="margin-top:8px"><a class="btn ghost sm" href="${qrUrl}&download=1" download="${esc(shop.slug)}-review-qr.png">Download QR</a></div>
        </div>
        <div style="flex:1;min-width:240px">
          <p class="muted" style="margin:0 0 10px">Print this QR for your reception desk, or show it to a client after their massage. They scan it, leave a rating (kept here in <strong>Reviews</strong>), and happy clients (4–5★) are then sent to <strong>Google</strong> — so your Maps rating grows while you keep a copy of every review.</p>
          <label>Your review link</label>
          <div class="inline">
            <input id="revlink" value="${esc(reviewUrl)}" readonly style="max-width:360px">
            <button class="btn ghost sm" type="button" onclick="navigator.clipboard.writeText(document.getElementById('revlink').value);this.textContent='Copied ✓'">Copy</button>
            <a class="btn ghost sm" href="${esc(reviewUrl)}" target="_blank">Open</a>
          </div>
          <p class="muted" style="font-size:.82rem;margin:10px 0 0">${shop.google_review_url ? '✅ Google review link is set — 4–5★ reviewers are sent there.' : `⚠️ <a href="/dashboard/settings">Add your Google review link</a> so happy clients are forwarded to Google Maps.`}</p>
        </div>
      </div>
    </div>
    <div class="grid g3" style="margin-bottom:18px">
      <div class="card" style="padding:18px"><div class="muted">Average</div><div class="stat">${agg.n ? (Math.round(agg.avg * 10) / 10).toFixed(1) : '—'} <span style="font-size:1rem;color:#e6a817">★</span></div></div>
      <div class="card" style="padding:18px"><div class="muted">Total reviews</div><div class="stat">${agg.n}</div></div>
      <div class="card" style="padding:18px"><div class="muted">Google link</div><div style="margin-top:6px">${shop.google_review_url ? '✅ set' : `<a href="/dashboard/settings">Add one</a>`}</div></div>
    </div>
    ${rows.length ? `<div class="card" style="padding:6px 18px"><table>
      <tr><th>When</th><th>Rating</th><th>Client</th><th>Therapist</th><th>Comment</th></tr>
      ${rows.map(r => `<tr>
        <td>${esc(formatBookingTime(r.created_at, shop.timezone))}</td>
        <td>${stars(r.rating)}</td>
        <td>${esc(r.customer_name || '—')}</td>
        <td>${esc(r.staff_name || '—')}</td>
        <td class="muted" style="max-width:340px;white-space:pre-wrap">${esc(r.body || '')}</td>
      </tr>`).join('')}
    </table></div>` : '<p class="muted">No reviews yet — clients are asked for one after you mark their booking “Done”.</p>'}
  `)
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
    (SELECT MAX(start_time) FROM bookings b WHERE b.shop_id = cl.shop_id AND ${clientMatch}) AS last_visit,
    (SELECT COALESCE(SUM(price_cents),0) FROM bookings b WHERE b.shop_id = cl.shop_id AND ${clientMatch} AND b.status IN ('confirmed','completed')) AS spent`
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
      <tr><th>Name</th><th>Phone</th><th>Visits</th><th>Total spent</th><th>Last visit</th><th>Notes</th></tr>
      ${rows.map(cl => `<tr>
        <td><a href="/dashboard/clients/${cl.id}"><strong>${esc(cl.name)}</strong></a>${cl.email ? `<div class="muted" style="font-size:.78rem">${esc(cl.email)}</div>` : ''}</td>
        <td>${esc(cl.phone || '—')}</td>
        <td>${cl.visits}</td>
        <td>${money(cl.spent || 0, shop.currency)}</td>
        <td>${cl.last_visit ? esc(formatBookingTime(cl.last_visit, shop.timezone)) : '—'}</td>
        <td class="muted" style="max-width:200px">${cl.notes ? esc(cl.notes.length > 50 ? cl.notes.slice(0, 50) + '…' : cl.notes) : ''}</td>
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
  // Lifetime totals (confirmed + completed).
  const tot = await db.prepare(
    `SELECT COUNT(*) visits, COALESCE(SUM(end_time-start_time),0) secs, COALESCE(SUM(price_cents),0) spent
     FROM bookings b WHERE b.shop_id=? AND (b.client_id=? OR (? <> '' AND lower(b.customer_email)=lower(?))) AND b.status IN ('confirmed','completed')`
  ).bind(shop.id, cl.id, cl.email || '', cl.email || '').first()
  const totMin = Math.round((tot?.secs || 0) / 60)
  const totTime = totMin >= 60 ? `${Math.floor(totMin / 60)}h ${totMin % 60}m` : `${totMin}m`

  const loy = await loyaltyStatus(db, shop, cl)
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
    <div class="grid g3" style="margin:14px 0 4px">
      <div class="card" style="padding:16px"><div class="muted">Visits</div><div class="stat">${tot?.visits || 0}</div></div>
      <div class="card" style="padding:16px"><div class="muted">Total time</div><div class="stat">${totTime}</div></div>
      <div class="card" style="padding:16px"><div class="muted">Total pay</div><div class="stat">${money(tot?.spent || 0, shop.currency)}</div></div>
    </div>
    ${loy.enabled ? `<div class="card" style="padding:14px 16px;margin:6px 0 0;background:#fdf7e8;border-color:#f0d9a8">
      🎁 <strong>Loyalty</strong> · ${loy.completed} completed visit${loy.completed === 1 ? '' : 's'}
      <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
        ${loy.tiers.map(t => `<span class="tag" style="background:${t.available ? '#e4f3ea' : (t.redeemed ? '#f0eeec' : '#fff')};color:${t.available ? '#2f8a5b' : '#7a736c'};border:1px solid var(--line)">${t.available ? '🎉 ' : (t.reached ? '✓ ' : '')}${t.visits} visits — ${esc(t.label)}${t.redeemed ? ' (used)' : ''}</span>`).join('')}
      </div>
      ${loy.available.length ? `<div style="margin-top:6px;color:#8a6414;font-weight:700">${loy.available.length} reward${loy.available.length === 1 ? '' : 's'} ready 🎉</div>` : (loy.next ? `<div class="muted" style="margin-top:6px">${loy.next.visits - loy.completed} more visit${loy.next.visits - loy.completed === 1 ? '' : 's'} to ${esc(loy.next.label)}</div>` : '')}
    </div>` : ''}
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
          <tr><th>When</th><th>Service</th><th>Therapist</th><th>Status</th><th>Notes</th></tr>
          ${history.map(b => `<tr><td>${esc(formatBookingTime(b.start_time, shop.timezone))}</td><td>${esc(b.service_name || '')}</td><td>${b.requested_staff ? '❤️ ' : ''}${esc(b.staff_name || '')}</td><td><span class="tag ${b.status}">${b.status.replace('_', ' ')}</span></td><td class="muted" style="font-size:.82rem;max-width:220px;white-space:pre-wrap">${b.notes ? esc(b.notes) : '—'}</td></tr>`).join('')}
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

// ─── Data export ─────────────────────────────────────────────────────────────
// Your data is yours. One-click, no lock-in — export clients, bookings, reviews
// as CSV, or everything as a single JSON file. This is the promise the landing
// page makes, so it must always work.
const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (headers, rows) =>
  [headers.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\r\n') + '\r\n'
const csvResponse = (c, filename, body) =>
  c.body('﻿' + body, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  })

app.get('/export/clients.csv', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const rows = (await db.prepare('SELECT * FROM clients WHERE shop_id=? ORDER BY name').bind(shop.id).all()).results || []
  const csv = toCsv(
    ['Name', 'Email', 'Phone', 'Notes', 'Added'],
    rows.map(r => [r.name, r.email, r.phone, r.notes, r.created_at ? formatBookingTime(r.created_at, shop.timezone) : ''])
  )
  return csvResponse(c, `${shop.slug}-clients.csv`, csv)
})

app.get('/export/bookings.csv', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const rows = (await db.prepare('SELECT * FROM bookings WHERE shop_id=? ORDER BY start_time DESC').bind(shop.id).all()).results || []
  const cur = shop.currency
  const csv = toCsv(
    ['When', 'Status', 'Service', 'Therapist', 'Customer', 'Email', 'Phone', 'Price', 'Deposit', 'Refunded', 'Requested therapist', 'Group', 'Notes'],
    rows.map(b => [
      formatBookingTime(b.start_time, shop.timezone), b.status, b.service_name, b.staff_name,
      b.customer_name, b.customer_email, b.customer_phone,
      b.price_cents != null ? money(b.price_cents, cur) : '', b.deposit_cents ? money(b.deposit_cents, cur) : '',
      b.refunded_at ? 'yes' : '', b.requested_staff ? 'yes' : '', b.group_id || '', b.notes,
    ])
  )
  return csvResponse(c, `${shop.slug}-bookings.csv`, csv)
})

app.get('/export/reviews.csv', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const rows = (await db.prepare('SELECT * FROM reviews WHERE shop_id=? ORDER BY created_at DESC').bind(shop.id).all()).results || []
  const csv = toCsv(
    ['When', 'Rating', 'Client', 'Therapist', 'Comment', 'Shared to Google'],
    rows.map(r => [r.created_at ? formatBookingTime(r.created_at, shop.timezone) : '', r.rating, r.customer_name, r.staff_name, r.body, r.shared_google ? 'yes' : ''])
  )
  return csvResponse(c, `${shop.slug}-reviews.csv`, csv)
})

// Everything, in one machine-readable file — nothing held back.
app.get('/export/all.json', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const grab = async (sql) => (await db.prepare(sql).bind(shop.id).all()).results || []
  const dump = {
    exported_at: new Date().toISOString(),
    shop,
    services: await grab('SELECT * FROM services WHERE shop_id=? ORDER BY sort_order'),
    staff: await grab('SELECT * FROM staff WHERE shop_id=? ORDER BY sort_order'),
    clients: await grab('SELECT * FROM clients WHERE shop_id=? ORDER BY name'),
    bookings: await grab('SELECT * FROM bookings WHERE shop_id=? ORDER BY start_time DESC'),
    reviews: await grab('SELECT * FROM reviews WHERE shop_id=? ORDER BY created_at DESC'),
    loyalty_tiers: await grab('SELECT * FROM loyalty_tiers WHERE shop_id=?'),
  }
  return c.body(JSON.stringify(dump, null, 2), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${shop.slug}-alisa-export.json"`,
  })
})

export default app
