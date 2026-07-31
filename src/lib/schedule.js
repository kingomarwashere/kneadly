// Shared "set my hours + days off + upcoming" editor, used by both the secret
// token portal (/t/:token) and the therapist account portal (/pro).
import { t, localeFor } from './i18n.js'
import { esc } from './views.js'
import { formatBookingTime, dateTzString } from './slots.js'
import { genId } from './auth.js'

// Localized short weekday names, indexed 0=Sun..6=Sat (2023-01-01 was a Sunday).
function weekdayNames(lang) {
  const fmt = new Intl.DateTimeFormat(localeFor(lang), { weekday: 'short' })
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2023, 0, 1 + i))))
}

const niceDate = (ds, lang) =>
  new Date(ds + 'T12:00:00Z').toLocaleDateString(localeFor(lang), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

// Load a staff member's current hours, upcoming days off, and upcoming bookings.
export async function loadSchedule(db, staff, shop) {
  const hours = (await db.prepare('SELECT * FROM availability WHERE staff_id = ? ORDER BY day_of_week').bind(staff.id).all()).results || []
  const hByDow = Object.fromEntries(hours.map(h => [h.day_of_week, h]))
  const today = dateTzString(new Date(), shop.timezone)
  const off = (await db.prepare('SELECT * FROM time_off WHERE staff_id = ? AND date >= ? ORDER BY date').bind(staff.id, today).all()).results || []
  const nowUnix = Math.floor(Date.now() / 1000)
  const upcoming = (await db.prepare(
    `SELECT * FROM bookings WHERE staff_id = ? AND status IN ('confirmed','pending_payment') AND start_time > ?
     ORDER BY start_time LIMIT 20`).bind(staff.id, nowUnix).all()).results || []
  return { hByDow, off, upcoming, today }
}

// The three editor cards (hours / days off / upcoming), localized. `actionBase`
// is the URL prefix that owns the POST endpoints, e.g. `/t/<token>` or
// `/pro/shop/<staffId>`.
export function scheduleCards(lang, staff, shop, sched, actionBase) {
  const { hByDow, off, upcoming, today } = sched
  const DOW = weekdayNames(lang)

  return `
    <div class="card" style="padding:22px;margin-top:18px">
      <h3 style="margin-top:0">🗓️ ${t(lang, 'th_weekly_hours')}</h3>
      <p class="muted" style="font-size:.88rem;margin-top:0">${t(lang, 'th_weekly_help')}</p>
      <form method="post" action="${actionBase}/hours">
        <table style="margin-bottom:12px"><tr><th></th><th>${t(lang, 'th_working')}</th><th>${t(lang, 'th_start')}</th><th>${t(lang, 'th_end')}</th></tr>
        ${DOW.map((d, i) => {
          const h = hByDow[i]
          return `<tr><td><strong>${esc(d)}</strong></td>
            <td><input type="checkbox" name="on_${i}" ${h ? 'checked' : ''} style="width:auto"></td>
            <td><input type="time" name="start_${i}" value="${h?.start_time || '09:00'}" style="max-width:130px"></td>
            <td><input type="time" name="end_${i}" value="${h?.end_time || '18:00'}" style="max-width:130px"></td></tr>`
        }).join('')}</table>
        <button class="btn">${t(lang, 'th_save_hours')}</button>
      </form>
    </div>

    <div class="card" style="padding:22px;margin-top:18px">
      <h3 style="margin-top:0">🌴 ${t(lang, 'th_days_off')}</h3>
      <p class="muted" style="font-size:.88rem;margin-top:0">${t(lang, 'th_days_off_help')}</p>
      <form method="post" action="${actionBase}/timeoff" class="inline" style="align-items:flex-end;margin-bottom:${off.length ? '16px' : '0'}">
        <div class="field" style="margin:0"><label>${t(lang, 'th_date')}</label><input type="date" name="date" min="${today}" required style="max-width:180px"></div>
        <div class="field" style="margin:0;flex:1"><label>${t(lang, 'th_reason')}</label><input name="reason" placeholder="${t(lang, 'th_reason_ph')}" style="min-width:140px"></div>
        <button class="btn sm">${t(lang, 'th_add_day_off')}</button>
      </form>
      ${off.length ? `<table><tr><th>${t(lang, 'th_date')}</th><th>${t(lang, 'th_reason')}</th><th></th></tr>
        ${off.map(o => `<tr><td><strong>${esc(niceDate(o.date, lang))}</strong></td><td class="muted">${esc(o.reason || '')}</td>
          <td style="text-align:right"><form method="post" action="${actionBase}/timeoff/${o.id}/delete"><button class="btn ghost sm">${t(lang, 'th_remove')}</button></form></td></tr>`).join('')}
      </table>` : ''}
    </div>

    <div class="card" style="padding:22px;margin-top:18px">
      <h3 style="margin-top:0">📅 ${t(lang, 'th_upcoming')}</h3>
      ${upcoming.length ? `<table><tr><th>${t(lang, 'c_when')}</th><th>${t(lang, 'c_service')}</th><th>${t(lang, 'th_client')}</th></tr>
        ${upcoming.map(b => `<tr><td>${formatBookingTime(b.start_time, shop.timezone)}</td><td>${esc(b.service_name)}</td>
          <td>${esc(b.customer_name)}${b.customer_phone ? `<div class="muted" style="font-size:.8rem">${esc(b.customer_phone)}</div>` : ''}</td></tr>`).join('')}
      </table>` : `<p class="muted" style="margin:0">${t(lang, 'th_no_upcoming')}</p>`}
    </div>`
}

// ─── Write helpers (shared by both portals) ──────────────────────────────────
export async function saveHours(db, staffId, form) {
  await db.prepare('DELETE FROM availability WHERE staff_id = ?').bind(staffId).run()
  for (let i = 0; i < 7; i++) {
    if (!form[`on_${i}`]) continue
    const start = (form[`start_${i}`] || '09:00').toString(), end = (form[`end_${i}`] || '18:00').toString()
    if (end <= start) continue
    await db.prepare('INSERT INTO availability (id, staff_id, day_of_week, start_time, end_time) VALUES (?, ?, ?, ?, ?)')
      .bind(genId(), staffId, i, start, end).run()
  }
}

export async function addTimeOff(db, staffId, form) {
  const date = (form.date || '').toString().trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
  await db.prepare('INSERT OR IGNORE INTO time_off (id, staff_id, date, reason) VALUES (?, ?, ?, ?)')
    .bind(genId(), staffId, date, (form.reason || '').toString().trim() || null).run()
}

export async function deleteTimeOff(db, staffId, id) {
  await db.prepare('DELETE FROM time_off WHERE id = ? AND staff_id = ?').bind(id, staffId).run()
}
