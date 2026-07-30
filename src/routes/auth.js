import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import { hashPassword, verifyPassword, genId, createSession, deleteSession } from '../lib/auth.js'
import { layout, siteNav, esc } from '../lib/views.js'

const app = new Hono()

const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

const RESERVED = new Set(['login', 'signup', 'logout', 'dashboard', 'api', 'webhooks', 'favicon.svg', 'og.svg', 'robots.txt', 'sitemap.xml', 'book', 'admin', 'about', 'pricing'])

function authPage(title, body, err) {
  return layout(title, `${siteNav(null)}<div class="wrap narrow" style="padding:40px 20px">
    <div class="card" style="padding:34px">
      ${err ? `<div class="notice err">${esc(err)}</div>` : ''}
      ${body}
    </div>
  </div>`)
}

app.get('/signup', (c) => {
  if (c.get('user')) return c.redirect('/dashboard')
  return c.html(authPage('Start your massage shop — Alisa', `
    <h2>Start taking bookings</h2>
    <p class="muted">Free to set up. You'll have a booking page in about two minutes.</p>
    <form method="post" action="/signup">
      <div class="field"><label>Shop name</label><input name="shop_name" required placeholder="Serenity Massage & Bodywork"></div>
      <div class="field"><label>Your name</label><input name="name" required placeholder="Alex Nguyen"></div>
      <div class="field"><label>Email</label><input type="email" name="email" required placeholder="you@shop.com"></div>
      <div class="field"><label>Password</label><input type="password" name="password" required minlength="8" placeholder="At least 8 characters"></div>
      <button class="btn" style="width:100%">Create my booking page</button>
    </form>
    <p class="muted" style="text-align:center;margin-top:16px">Already have an account? <a href="/login">Log in</a></p>
  `))
})

app.post('/signup', async (c) => {
  const db = c.env.DB
  const form = await c.req.parseBody()
  const shopName = (form.shop_name || '').toString().trim()
  const name = (form.name || '').toString().trim()
  const email = (form.email || '').toString().trim().toLowerCase()
  const password = (form.password || '').toString()

  if (!shopName || !name || !email || password.length < 8)
    return c.html(authPage('Sign up', signupForm(form), 'Please fill in every field (password 8+ chars).'), 400)

  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) return c.html(authPage('Sign up', signupForm(form), 'That email is already registered. Try logging in.'), 400)

  // Unique slug from shop name
  let base = slugify(shopName) || 'shop'
  if (RESERVED.has(base)) base = base + '-massage'
  let slug = base, n = 1
  while (await db.prepare('SELECT id FROM shops WHERE slug = ?').bind(slug).first()) slug = `${base}-${++n}`

  const userId = genId(), shopId = genId()
  await db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
    .bind(userId, email, name, await hashPassword(password)).run()
  await db.prepare(`INSERT INTO shops (id, owner_id, name, slug, email, tagline) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(shopId, userId, shopName, slug, email, 'Relax. Recover. Rebook.').run()

  // Seed a default therapist with sensible Mon–Sat hours so the shop can take bookings immediately
  const staffId = genId()
  await db.prepare(`INSERT INTO staff (id, shop_id, name, title) VALUES (?, ?, ?, ?)`)
    .bind(staffId, shopId, name, 'Massage Therapist').run()
  for (let dow = 1; dow <= 6; dow++)
    await db.prepare(`INSERT INTO availability (id, staff_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)`)
      .bind(genId(), staffId, dow, '09:00', '18:00').run()

  const sessionId = await createSession(db, userId)
  setCookie(c, 'alisa_session', sessionId, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 86400 * 30, path: '/' })
  return c.redirect('/dashboard?welcome=1')
})

function signupForm(form = {}) {
  return `<h2>Start taking bookings</h2>
    <form method="post" action="/signup">
      <div class="field"><label>Shop name</label><input name="shop_name" required value="${esc(form.shop_name || '')}"></div>
      <div class="field"><label>Your name</label><input name="name" required value="${esc(form.name || '')}"></div>
      <div class="field"><label>Email</label><input type="email" name="email" required value="${esc(form.email || '')}"></div>
      <div class="field"><label>Password</label><input type="password" name="password" required minlength="8"></div>
      <button class="btn" style="width:100%">Create my booking page</button>
    </form>`
}

app.get('/login', (c) => {
  if (c.get('user')) return c.redirect('/dashboard')
  return c.html(authPage('Log in — Alisa', `
    <h2>Welcome back</h2>
    <form method="post" action="/login">
      <div class="field"><label>Email</label><input type="email" name="email" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" required></div>
      <button class="btn" style="width:100%">Log in</button>
    </form>
    <p class="muted" style="text-align:center;margin-top:16px">New here? <a href="/signup">Create your shop</a></p>
  `))
})

app.post('/login', async (c) => {
  const db = c.env.DB
  const form = await c.req.parseBody()
  const email = (form.email || '').toString().trim().toLowerCase()
  const password = (form.password || '').toString()
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first()
  if (!user || !(await verifyPassword(password, user.password_hash)))
    return c.html(authPage('Log in', `<h2>Welcome back</h2>
      <form method="post" action="/login">
        <div class="field"><label>Email</label><input type="email" name="email" value="${esc(email)}" required></div>
        <div class="field"><label>Password</label><input type="password" name="password" required></div>
        <button class="btn" style="width:100%">Log in</button>
      </form>`, 'Incorrect email or password.'), 401)

  const sessionId = await createSession(db, user.id)
  setCookie(c, 'alisa_session', sessionId, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 86400 * 30, path: '/' })
  return c.redirect('/dashboard')
})

app.get('/logout', async (c) => {
  const sid = c.req.header('cookie')?.match(/alisa_session=([^;]+)/)?.[1]
  if (sid) await deleteSession(c.env.DB, sid)
  deleteCookie(c, 'alisa_session', { path: '/' })
  return c.redirect('/')
})

export default app
