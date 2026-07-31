import { Hono } from 'hono'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import { layout, siteNav, esc } from '../lib/views.js'
import { t } from '../lib/i18n.js'
import {
  hashPassword, verifyPassword, genId,
  createTherapistSession, getTherapistSession, deleteTherapistSession, claimStaffByEmail,
} from '../lib/auth.js'
import { loadSchedule, scheduleCards, saveHours, addTimeOff, deleteTimeOff } from '../lib/schedule.js'

// Therapist login accounts. ONE login spans every shop a therapist works at —
// staff rows are linked to an account by matching email. This is what lets a
// therapist "move around" between shops and manage them all in one place.
const app = new Hono()
const COOKIE = 'alisa_pro'

// Attach the logged-in therapist (if any) to the context.
app.use('*', async (c, next) => {
  const sid = getCookie(c, COOKIE)
  if (sid) {
    const me = await getTherapistSession(c.env.DB, sid)
    if (me) c.set('therapist', me)
  }
  await next()
})

function proPage(lang, title, inner, err) {
  return layout(`${title} — Alisa`, `${siteNav(null, lang)}
    <div class="wrap narrow" style="padding:40px 20px">
      <div class="card" style="padding:34px">
        ${err ? `<div class="notice err">${esc(err)}</div>` : ''}
        ${inner}
      </div>
    </div>`, { lang })
}

// ─── Dashboard: my shops ─────────────────────────────────────────────────────
app.get('/', async (c) => {
  const lang = c.get('lang'), me = c.get('therapist')
  if (!me) return c.redirect('/pro/login')
  const rows = (await c.env.DB.prepare(
    `SELECT st.id staff_id, st.title, st.emoji, sh.name shop_name, sh.slug
     FROM staff st JOIN shops sh ON sh.id = st.shop_id
     WHERE st.therapist_id = ? ORDER BY sh.name`).bind(me.id).all()).results || []

  const shopCards = rows.map(r => `
    <div class="card" style="padding:18px 20px;margin-bottom:12px">
      <div class="inline" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div><span style="font-size:1.3rem">${esc(r.emoji)}</span> <strong>${esc(r.shop_name)}</strong>
          <div class="muted" style="font-size:.85rem">${esc(r.title || 'Therapist')}</div></div>
        <a class="btn sm" href="/pro/shop/${r.staff_id}">${t(lang, 'pro_manage')}</a>
      </div>
    </div>`).join('')

  return c.html(layout(`${t(lang, 'pro_my_shops')} — Alisa`, `
    ${siteNav(null, lang)}
    <div class="wrap" style="padding:24px 20px;max-width:720px">
      <div class="inline" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div><h2 style="margin:0">${t(lang, 'th_hi', { name: esc(me.name.split(' ')[0]) })}</h2>
          <div class="muted">${esc(me.email)}</div></div>
        <a class="btn ghost sm" href="/pro/logout">${t(lang, 'pro_logout')}</a>
      </div>
      <h3 style="margin-top:22px">${t(lang, 'pro_my_shops')}</h3>
      <p class="muted" style="margin-top:-6px;font-size:.9rem">${t(lang, 'pro_my_shops_help')}</p>
      ${shopCards || `<div class="card" style="padding:20px"><p class="muted" style="margin:0">${t(lang, 'pro_no_shops')}</p></div>`}
    </div>`, { lang }))
})

// ─── Login ───────────────────────────────────────────────────────────────────
app.get('/login', (c) => {
  const lang = c.get('lang')
  if (c.get('therapist')) return c.redirect('/pro')
  return c.html(proPage(lang, t(lang, 'pro_title'), loginForm(lang)))
})
function loginForm(lang, email = '') {
  return `<h2>${t(lang, 'pro_welcome')}</h2>
    <p class="muted">${t(lang, 'pro_tagline')}</p>
    <form method="post" action="/pro/login">
      <div class="field"><label>${t(lang, 'email')}</label><input type="email" name="email" value="${esc(email)}" required></div>
      <div class="field"><label>${t(lang, 'pro_password')}</label><input type="password" name="password" required></div>
      <button class="btn" style="width:100%">${t(lang, 'pro_login_btn')}</button>
    </form>
    <p class="muted" style="text-align:center;margin-top:16px">${t(lang, 'pro_new')} <a href="/pro/signup">${t(lang, 'pro_create_btn')}</a></p>`
}

app.post('/login', async (c) => {
  const db = c.env.DB, lang = c.get('lang')
  const f = await c.req.parseBody()
  const email = (f.email || '').toString().trim().toLowerCase()
  const password = (f.password || '').toString()
  const me = await db.prepare('SELECT * FROM therapists WHERE email = ?').bind(email).first()
  if (!me || !(await verifyPassword(password, me.password_hash)))
    return c.html(proPage(lang, t(lang, 'pro_title'), loginForm(lang, email), t(lang, 'pro_bad_login')), 401)
  await claimStaffByEmail(db, me.id, me.email)
  const sid = await createTherapistSession(db, me.id)
  setCookie(c, COOKIE, sid, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 86400 * 30, path: '/' })
  return c.redirect('/pro')
})

// ─── Signup ──────────────────────────────────────────────────────────────────
app.get('/signup', async (c) => {
  const lang = c.get('lang')
  if (c.get('therapist')) return c.redirect('/pro')
  // If arriving from a token link, prefill from that staff row.
  const claim = c.req.query('claim')
  let prefill = {}
  if (claim) {
    const st = await c.env.DB.prepare('SELECT name, email FROM staff WHERE token = ?').bind(claim).first()
    if (st) prefill = { name: st.name, email: st.email || '' }
  }
  return c.html(proPage(lang, t(lang, 'pro_create_btn'), signupForm(lang, { ...prefill, claim })))
})
function signupForm(lang, f = {}) {
  return `<h2>${t(lang, 'pro_create_btn')}</h2>
    <p class="muted">${t(lang, 'pro_tagline')}</p>
    <form method="post" action="/pro/signup">
      ${f.claim ? `<input type="hidden" name="claim" value="${esc(f.claim)}">` : ''}
      <div class="field"><label>${t(lang, 'pro_your_name')}</label><input name="name" value="${esc(f.name || '')}" required></div>
      <div class="field"><label>${t(lang, 'email')}</label><input type="email" name="email" value="${esc(f.email || '')}" required></div>
      <div class="field"><label>${t(lang, 'pro_password')}</label><input type="password" name="password" required minlength="8"></div>
      <button class="btn" style="width:100%">${t(lang, 'pro_create_btn')}</button>
    </form>
    <p class="muted" style="text-align:center;margin-top:16px">${t(lang, 'pro_have')} <a href="/pro/login">${t(lang, 'pro_login_btn')}</a></p>`
}

app.post('/signup', async (c) => {
  const db = c.env.DB, lang = c.get('lang')
  const f = await c.req.parseBody()
  const name = (f.name || '').toString().trim()
  const email = (f.email || '').toString().trim().toLowerCase()
  const password = (f.password || '').toString()
  const claim = (f.claim || '').toString()

  if (!name || !email || password.length < 8)
    return c.html(proPage(lang, t(lang, 'pro_create_btn'), signupForm(lang, { name, email, claim }), t(lang, 'pro_fill')), 400)
  if (await db.prepare('SELECT id FROM therapists WHERE email = ?').bind(email).first())
    return c.html(proPage(lang, t(lang, 'pro_create_btn'), signupForm(lang, { name, email, claim }), t(lang, 'pro_email_taken')), 400)

  const id = genId()
  await db.prepare('INSERT INTO therapists (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .bind(id, email, name, await hashPassword(password)).run()

  // Link the specific staff row we came from (stamp its email so future logins keep it linked)…
  if (claim) {
    await db.prepare('UPDATE staff SET therapist_id = ?, email = COALESCE(NULLIF(email, \'\'), ?) WHERE token = ?')
      .bind(id, email, claim).run()
  }
  // …and every other staff row that already carries this email.
  await claimStaffByEmail(db, id, email)

  const sid = await createTherapistSession(db, id)
  setCookie(c, COOKIE, sid, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 86400 * 30, path: '/' })
  return c.redirect('/pro')
})

app.get('/logout', async (c) => {
  const sid = getCookie(c, COOKIE)
  if (sid) await deleteTherapistSession(c.env.DB, sid)
  deleteCookie(c, COOKIE, { path: '/' })
  return c.redirect('/pro/login')
})

// ─── Per-shop schedule management (must own the staff row) ───────────────────
async function loadOwnedStaff(c, next) {
  const me = c.get('therapist')
  if (!me) return c.redirect('/pro/login')
  const staff = await c.env.DB.prepare('SELECT * FROM staff WHERE id = ? AND therapist_id = ?')
    .bind(c.req.param('staffId'), me.id).first()
  if (!staff) return c.redirect('/pro')
  const shop = await c.env.DB.prepare('SELECT * FROM shops WHERE id = ?').bind(staff.shop_id).first()
  c.set('staff', staff)
  c.set('shop', shop)
  await next()
}
app.use('/shop/:staffId', loadOwnedStaff)
app.use('/shop/:staffId/*', loadOwnedStaff)

app.get('/shop/:staffId', async (c) => {
  const db = c.env.DB, staff = c.get('staff'), shop = c.get('shop'), lang = c.get('lang')
  const saved = c.req.query('saved')
  const sched = await loadSchedule(db, staff, shop)
  const base = `/pro/shop/${staff.id}`
  return c.html(layout(`${esc(shop.name)} — Alisa`, `
    ${siteNav(null, lang)}
    <div class="wrap" style="padding:24px 20px;max-width:760px">
      <a href="/pro" class="muted">← ${t(lang, 'pro_my_shops')}</a>
      <div class="inline" style="gap:10px;margin-top:8px">
        <span style="font-size:1.8rem">${esc(shop.emoji)}</span>
        <div><h2 style="margin:0">${esc(shop.name)}</h2>
        <div class="muted">${esc(staff.title || 'Therapist')}</div></div>
      </div>
      ${saved ? `<div class="notice ok" style="margin-top:16px">${t(lang, 'th_saved')}</div>` : ''}
      ${scheduleCards(lang, staff, shop, sched, base)}
    </div>`, { lang }))
})

app.post('/shop/:staffId/hours', async (c) => {
  const staff = c.get('staff')
  await saveHours(c.env.DB, staff.id, await c.req.parseBody())
  return c.redirect(`/pro/shop/${staff.id}?saved=1`)
})
app.post('/shop/:staffId/timeoff', async (c) => {
  const staff = c.get('staff')
  await addTimeOff(c.env.DB, staff.id, await c.req.parseBody())
  return c.redirect(`/pro/shop/${staff.id}?saved=1`)
})
app.post('/shop/:staffId/timeoff/:id/delete', async (c) => {
  const staff = c.get('staff')
  await deleteTimeOff(c.env.DB, staff.id, c.req.param('id'))
  return c.redirect(`/pro/shop/${staff.id}?saved=1`)
})

export default app
