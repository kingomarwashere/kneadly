import { Hono } from 'hono'
import { layout, siteNav, esc } from '../lib/views.js'
import { t } from '../lib/i18n.js'
import { loadSchedule, scheduleCards, saveHours, addTimeOff, deleteTimeOff } from '../lib/schedule.js'

// Therapist self-service via a secret per-staff token link (no password). This
// is the lightweight option; a full account that spans shops lives at /pro.
const app = new Hono()

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
  const lang = c.get('lang')
  return layout(`${t(lang, 'th_link_bad_title')} — Alisa`, `${siteNav(null, lang)}
    <div class="wrap narrow" style="padding:60px 20px;text-align:center">
      <div style="font-size:2.5rem">🔒</div>
      <h2>${t(lang, 'th_link_bad_title')}</h2>
      <p class="muted">${t(lang, 'th_link_bad_sub')}</p>
    </div>`, { lang })
}

app.get('/:token', async (c) => {
  const db = c.env.DB, staff = c.get('staff'), shop = c.get('shop'), lang = c.get('lang')
  const saved = c.req.query('saved')
  const sched = await loadSchedule(db, staff, shop)
  const base = `/t/${staff.token}`

  // Nudge toward a single login if this staff row isn't linked to an account yet.
  const claimBanner = staff.therapist_id ? '' : `
    <div class="card" style="padding:14px 18px;margin-top:16px;background:#eef4f3;border:none">
      <div class="inline" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span style="font-size:.9rem">🧑‍⚕️ ${t(lang, 'pro_all_shops_cta')}</span>
        <a class="btn sm" href="/pro/signup?claim=${staff.token}">${t(lang, 'pro_create_btn')}</a>
      </div>
    </div>`

  return c.html(layout(`${t(lang, 'th_weekly_hours')} — ${shop.name}`, `
  ${siteNav(null, lang)}
  <div class="wrap" style="padding:24px 20px;max-width:760px">
    <div class="inline" style="gap:10px">
      <span style="font-size:1.8rem">${esc(staff.emoji)}</span>
      <div><h2 style="margin:0">${t(lang, 'th_hi', { name: esc(staff.name.split(' ')[0]) })}</h2>
      <div class="muted">${esc(staff.title || 'Therapist')} · ${esc(shop.name)}</div></div>
    </div>
    ${saved ? `<div class="notice ok" style="margin-top:16px">${t(lang, 'th_saved')}</div>` : ''}
    ${claimBanner}
    ${scheduleCards(lang, staff, shop, sched, base)}
    <p class="muted" style="font-size:.78rem;margin-top:18px">${t(lang, 'th_private_note')}</p>
  </div>`, { lang }))
})

app.post('/:token/hours', async (c) => {
  const staff = c.get('staff')
  await saveHours(c.env.DB, staff.id, await c.req.parseBody())
  return c.redirect(`/t/${staff.token}?saved=1`)
})

app.post('/:token/timeoff', async (c) => {
  const staff = c.get('staff')
  await addTimeOff(c.env.DB, staff.id, await c.req.parseBody())
  return c.redirect(`/t/${staff.token}?saved=1`)
})

app.post('/:token/timeoff/:id/delete', async (c) => {
  const staff = c.get('staff')
  await deleteTimeOff(c.env.DB, staff.id, c.req.param('id'))
  return c.redirect(`/t/${staff.token}?saved=1`)
})

export default app
