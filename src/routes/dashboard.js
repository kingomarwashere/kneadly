import { Hono } from 'hono'
import { layout, money, esc } from '../lib/views.js'
import { genId } from '../lib/auth.js'
import { formatBookingTime } from '../lib/slots.js'
import { stripeClient } from '../lib/stripe.js'

const app = new Hono()
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
      ${tab('bookings', '🗓️ Bookings')}
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
    <div class="inline" style="justify-content:space-between"><h2>Bookings</h2><div class="inline">${tabs}</div></div>
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
  }
  return c.redirect('/dashboard/bookings')
}
app.post('/bookings/:id/complete', c => bookingAction(c, 'complete'))
app.post('/bookings/:id/no_show', c => bookingAction(c, 'no_show'))
app.post('/bookings/:id/cancel', c => bookingAction(c, 'cancel'))

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
  const staff = (await db.prepare('SELECT * FROM staff WHERE shop_id = ? ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const hoursFor = async (id) => (await db.prepare('SELECT * FROM availability WHERE staff_id = ? ORDER BY day_of_week').bind(id).all()).results || []

  const cards = []
  for (const st of staff) {
    const hours = await hoursFor(st.id)
    const hByDow = Object.fromEntries(hours.map(h => [h.day_of_week, h]))
    cards.push(`<div class="card" style="padding:20px;margin-bottom:16px">
      <div class="inline" style="justify-content:space-between">
        <div><span style="font-size:1.4rem">${esc(st.emoji)}</span> <strong>${esc(st.name)}</strong> <span class="muted">${esc(st.title || '')}</span></div>
        <form method="post" action="/dashboard/staff/${st.id}/delete" onsubmit="return confirm('Remove this therapist?')"><button class="btn danger sm">Remove</button></form>
      </div>
      <form method="post" action="/dashboard/staff/${st.id}/hours" style="margin-top:14px">
        <label>Weekly hours</label>
        <table style="margin-bottom:12px"><tr><th></th><th>Open</th><th>Start</th><th>End</th></tr>
        ${DOW.map((d, i) => {
          const h = hByDow[i]
          return `<tr><td><strong>${d}</strong></td>
            <td><input type="checkbox" name="on_${i}" ${h ? 'checked' : ''} style="width:auto"></td>
            <td><input type="time" name="start_${i}" value="${h?.start_time || '09:00'}" style="max-width:130px"></td>
            <td><input type="time" name="end_${i}" value="${h?.end_time || '18:00'}" style="max-width:130px"></td></tr>`
        }).join('')}</table>
        <button class="btn sm">Save hours</button>
      </form>
    </div>`)
  }

  return shell(c, 'staff', 'Therapists', `
    <h2>Therapists</h2>
    ${cards.join('') || '<p class="muted">No therapists yet.</p>'}
    <div class="card" style="padding:22px">
      <h3 style="margin-top:0">Add a therapist</h3>
      <form method="post" action="/dashboard/staff">
        <div class="row">
          <div class="field"><label>Name</label><input name="name" required placeholder="Jordan Lee"></div>
          <div class="field"><label>Title</label><input name="title" value="Massage Therapist"></div>
          <div class="field" style="flex:0 0 90px"><label>Emoji</label><input name="emoji" value="🧑‍⚕️" maxlength="4"></div>
        </div>
        <button class="btn">Add therapist</button>
      </form>
    </div>
  `)
})

app.post('/staff', async (c) => {
  const db = c.env.DB, shop = c.get('shop')
  const f = await c.req.parseBody()
  const id = genId()
  await db.prepare('INSERT INTO staff (id, shop_id, name, title, emoji, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, shop.id, (f.name || '').toString().trim(), (f.title || 'Massage Therapist').toString().trim(),
      (f.emoji || '🧑‍⚕️').toString().trim() || '🧑‍⚕️', Math.floor(Date.now() / 1000)).run()
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
        </div>
        <p class="muted" style="font-size:.82rem;margin:0">Set deposit to 0% to take bookings with no upfront payment.</p>
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

  await db.prepare(`UPDATE shops SET name=?, emoji=?, tagline=?, about=?, slug=?, accent=?, phone=?, email=?,
    address=?, suburb=?, state=?, postcode=?, timezone=?, deposit_pct=?, cancellation_hours=? WHERE id=?`)
    .bind((f.name || shop.name).toString().trim(), (f.emoji || '💆').toString().trim() || '💆',
      (f.tagline || '').toString(), (f.about || '').toString(), slug, (f.accent || '#0f766e').toString(),
      (f.phone || '').toString(), (f.email || '').toString(), (f.address || '').toString(),
      (f.suburb || '').toString(), (f.state || '').toString(), (f.postcode || '').toString(),
      (f.timezone || shop.timezone).toString(), parseInt(f.deposit_pct) || 0, parseInt(f.cancellation_hours) || 0, shop.id).run()
  return c.redirect('/dashboard/settings')
})

export default app
