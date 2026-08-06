import { generateSlots, getDayOfWeek, dateTzString, localToUtcMs } from './slots.js'

export async function getShopBySlug(db, slug) {
  return db.prepare('SELECT * FROM shops WHERE slug = ?').bind(slug).first()
}

const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m }
const fmtHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// Shop opening hours for a weekday (0=Sun..6=Sat), parsed from shops.hours_json.
// Returns: undefined = no shop hours configured (no constraint) · null = closed
// that day · { open:'HH:MM', close:'HH:MM' } otherwise.
export function shopHoursFor(shop, dow) {
  if (!shop || !shop.hours_json) return undefined
  let h
  try { h = JSON.parse(shop.hours_json) } catch { return undefined }
  if (!h || typeof h !== 'object') return undefined
  const v = h[dow] ?? h[String(dow)]
  if (!v || !v[0] || !v[1]) return null
  return { open: v[0], close: v[1] }
}

// Intersect a therapist's availability window with the shop's opening hours for
// that weekday. Returns a { start_time, end_time } window, or null if the shop
// is closed / there is no overlap. If no shop hours are set, returns avail as-is.
export function clampAvail(shop, dow, avail) {
  const sh = shopHoursFor(shop, dow)
  if (sh === undefined) return avail
  if (sh === null) return null
  const s = Math.max(toMin(avail.start_time), toMin(sh.open))
  const e = Math.min(toMin(avail.end_time), toMin(sh.close))
  if (e <= s) return null
  return { ...avail, start_time: fmtHM(s), end_time: fmtHM(e) }
}

// Cheap "does at least one bookable slot exist?" for a clamped window on a date.
// Uses start-of-day unix + minute offset (avoids per-slot Intl); good enough for
// deciding whether a DATE should be offered (the real list uses generateSlots).
function hasAnySlot(win, bookings, dayStartSec, durationMin, interval, nowSec) {
  const s0 = toMin(win.start_time), e0 = toMin(win.end_time)
  for (let cur = s0; cur + durationMin <= e0; cur += interval) {
    const startSec = dayStartSec + cur * 60
    if (startSec <= nowSec) continue
    const endSec = startSec + durationMin * 60
    if (!bookings.some(b => b.start_time < endSec && b.end_time > startSec)) return true
  }
  return false
}

// Active staff who can perform a service. If nobody is explicitly linked to the
// service, every active staff member is considered eligible.
export async function eligibleStaff(db, shopId, serviceId) {
  const linked = await db.prepare(
    `SELECT s.* FROM staff s JOIN staff_services ss ON ss.staff_id = s.id
     WHERE ss.service_id = ? AND s.shop_id = ? AND s.is_active = 1 ORDER BY s.sort_order, s.created_at`
  ).bind(serviceId, shopId).all()
  if ((linked.results || []).length) return linked.results
  const all = await db.prepare(
    `SELECT * FROM staff WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, created_at`
  ).bind(shopId).all()
  return all.results || []
}

// Is a therapist free for [startUnix, endUnix)? (no overlapping active booking).
// Pass excludeBookingId to ignore the booking being edited/moved.
export async function therapistFreeAt(db, staffId, startUnix, endUnix, excludeBookingId = null) {
  const row = await db.prepare(
    "SELECT 1 FROM bookings WHERE staff_id=? AND status IN ('pending_payment','confirmed','completed') AND start_time < ? AND end_time > ? AND id <> ? LIMIT 1"
  ).bind(staffId, endUnix, startUnix, excludeBookingId || '').first()
  return !row
}

// Pick a therapist for "any available": eligible for the service, works that day,
// not on time-off, and with NO overlapping booking. Never over-books — returns
// null if nobody is genuinely free. Works for custom (non-slot) times too.
export async function freeTherapist(db, shop, service, startUnix, endUnix, excludeIds = new Set(), excludeBookingId = null) {
  const eligible = await eligibleStaff(db, shop.id, service.id)
  const dateStr = dateTzString(new Date(startUnix * 1000), shop.timezone)
  const dow = getDayOfWeek(dateStr, shop.timezone)
  for (const st of eligible) {
    if (excludeIds.has(st.id)) continue
    const avail = await db.prepare('SELECT 1 FROM availability WHERE staff_id=? AND day_of_week=?').bind(st.id, dow).first()
    if (!avail) continue
    const off = await db.prepare('SELECT 1 FROM time_off WHERE staff_id=? AND date=?').bind(st.id, dateStr).first()
    if (off) continue
    if (!(await therapistFreeAt(db, st.id, startUnix, endUnix, excludeBookingId))) continue
    return { id: st.id, name: st.name }
  }
  return null
}

// Free time-slots for a date. Returns [{ time, unix, display, staffIds:[...] }]
// staffIds = the therapists actually free at that moment (used to assign "any").
export async function slotsForDate(db, shop, service, staffId, dateStr) {
  let staff = await eligibleStaff(db, shop.id, service.id)
  if (staffId && staffId !== 'any') staff = staff.filter(s => s.id === staffId)
  if (!staff.length) return []

  const dow = getDayOfWeek(dateStr, shop.timezone)
  const dayStart = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000) - 86400
  const dayEnd = dayStart + 86400 * 3

  const byTime = new Map()
  for (const st of staff) {
    const avail = await db.prepare(
      'SELECT * FROM availability WHERE staff_id = ? AND day_of_week = ?').bind(st.id, dow).first()
    if (!avail) continue
    // Skip therapists who've marked this date as a day off
    const off = await db.prepare(
      'SELECT 1 FROM time_off WHERE staff_id = ? AND date = ?').bind(st.id, dateStr).first()
    if (off) continue
    // Constrain to the shop's opening hours (skip if closed / no overlap).
    const win = clampAvail(shop, dow, avail)
    if (!win) continue
    const booked = await db.prepare(
      `SELECT start_time, end_time FROM bookings
       WHERE staff_id = ? AND status IN ('pending_payment','confirmed','completed')
       AND start_time BETWEEN ? AND ?`).bind(st.id, dayStart, dayEnd).all()
    const slots = generateSlots(win, booked.results || [], dateStr, service.duration_minutes, shop.timezone, shop.slot_interval_minutes)
    for (const s of slots) {
      if (!byTime.has(s.time)) byTime.set(s.time, { ...s, staffIds: [] })
      byTime.get(s.time).staffIds.push(st.id)
    }
  }
  return [...byTime.values()].sort((a, b) => a.unix - b.unix)
}

// Dates within the next `daysAhead` that have at least one ACTUALLY bookable
// slot — i.e. some eligible therapist works that weekday, isn't off, the shop is
// open, and a free gap remains after the booking lead time. This deliberately
// excludes "today" once the day is over and any fully-booked day, so the date
// picker never offers a date that then shows "fully booked".
export async function availableDates(db, shop, service, staffId, daysAhead = 45) {
  let staff = await eligibleStaff(db, shop.id, service.id)
  if (staffId && staffId !== 'any') staff = staff.filter(s => s.id === staffId)
  if (!staff.length) return []

  const tz = shop.timezone
  const interval = Math.max(5, Number(shop.slot_interval_minutes) || 15)
  const nowSec = Math.floor(Date.now() / 1000) + 30 * 60 // 30-min lead time
  const windowEnd = nowSec + (daysAhead + 2) * 86400

  // Preload per therapist: availability by weekday, days off, and the bookings
  // that could collide within the search window — so the date loop is pure CPU.
  const info = []
  for (const st of staff) {
    const availByDow = {}
    for (const a of ((await db.prepare('SELECT day_of_week,start_time,end_time FROM availability WHERE staff_id = ?').bind(st.id).all()).results || [])) availByDow[a.day_of_week] = a
    const off = new Set(((await db.prepare('SELECT date FROM time_off WHERE staff_id = ?').bind(st.id).all()).results || []).map(r => r.date))
    const bookings = (await db.prepare(
      `SELECT start_time,end_time FROM bookings WHERE staff_id = ?
       AND status IN ('pending_payment','confirmed','completed') AND end_time > ? AND start_time < ?`
    ).bind(st.id, nowSec - 86400, windowEnd).all()).results || []
    info.push({ availByDow, off, bookings })
  }

  const out = []
  const now = new Date()
  const todayStr = dateTzString(now, tz)
  for (let i = 0; i <= daysAhead; i++) {
    const ds = dateTzString(new Date(now.getTime() + i * 86400000), tz)
    if (ds < todayStr) continue
    const dow = getDayOfWeek(ds, tz)
    const dayStartSec = Math.floor(localToUtcMs(ds, '00:00', tz) / 1000)
    let ok = false
    for (const x of info) {
      const avail = x.availByDow[dow]
      if (!avail || x.off.has(ds)) continue
      const win = clampAvail(shop, dow, avail)
      if (!win) continue
      if (hasAnySlot(win, x.bookings, dayStartSec, service.duration_minutes, interval, nowSec)) { ok = true; break }
    }
    if (ok) out.push(ds)
  }
  return out
}

// ── Group / party availability ───────────────────────────────────────────────
// Everything needed to test SIMULTANEOUS availability on a date, loaded once.
export async function dayContext(db, shop, dateStr) {
  const tz = shop.timezone
  const dow = getDayOfWeek(dateStr, tz)
  const staff = (await db.prepare('SELECT id,name,emoji FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const staffById = {}; for (const s of staff) staffById[s.id] = s
  const dayStartU = Math.floor(localToUtcMs(dateStr, '00:00', tz) / 1000)
  const sh = shopHoursFor(shop, dow) // undefined = no constraint · null = closed · {open,close}
  const availByStaff = {}
  if (sh !== null) {
    const clampS = sh ? toMin(sh.open) : null, clampE = sh ? toMin(sh.close) : null
    for (const a of ((await db.prepare('SELECT a.staff_id,a.start_time,a.end_time FROM availability a JOIN staff s ON s.id=a.staff_id WHERE s.shop_id=? AND s.is_active=1 AND a.day_of_week=?').bind(shop.id, dow).all()).results || [])) {
      let s = toMin(a.start_time), e = toMin(a.end_time)
      if (clampS != null) { s = Math.max(s, clampS); e = Math.min(e, clampE) }
      if (e <= s) continue
      availByStaff[a.staff_id] = { sU: dayStartU + s * 60, eU: dayStartU + e * 60, sMin: s, eMin: e }
    }
  }
  const offIds = new Set(((await db.prepare('SELECT t.staff_id FROM time_off t JOIN staff s ON s.id=t.staff_id WHERE s.shop_id=? AND t.date=?').bind(shop.id, dateStr).all()).results || []).map(o => o.staff_id))
  const booked = (await db.prepare("SELECT staff_id,start_time,end_time FROM bookings WHERE shop_id=? AND start_time>=? AND start_time<? AND status IN ('pending_payment','confirmed','completed')").bind(shop.id, dayStartU, dayStartU + 86400).all()).results || []
  const bkByStaff = {}; for (const b of booked) (bkByStaff[b.staff_id] ||= []).push(b)
  const eligByService = {} // service -> Set(staffId); a service with no links = all staff eligible
  for (const l of ((await db.prepare('SELECT ss.service_id, ss.staff_id FROM staff_services ss JOIN staff s ON s.id=ss.staff_id WHERE s.shop_id=? AND s.is_active=1').bind(shop.id).all()).results || []))
    (eligByService[l.service_id] ||= new Set()).add(l.staff_id)
  return { tz, dow, staff, staffById, availByStaff, offIds, bkByStaff, eligByService, dayStartU, shopClosed: sh === null }
}

// staffIds that can perform `service` (durSec) starting at unix T under prefs.
function freeStaffFor(ctx, serviceId, durSec, T, pref) {
  const elig = ctx.eligByService[serviceId] // Set or undefined => all eligible
  const endT = T + durSec
  const out = []
  for (const st of ctx.staff) {
    const id = st.id
    if (pref && pref !== 'any' && pref !== id) continue
    if (elig && !elig.has(id)) continue
    if (ctx.offIds.has(id)) continue
    const w = ctx.availByStaff[id]; if (!w) continue
    if (T < w.sU || endT > w.eU) continue
    if ((ctx.bkByStaff[id] || []).some(b => b.start_time < endT && b.end_time > T)) continue
    out.push(id)
  }
  return out
}

// Assign each person a DISTINCT therapist from their candidate set (fewest
// options first + backtracking). Returns staffIds aligned to input, or null.
function matchAssign(sets) {
  const order = sets.map((s, i) => [i, s]).sort((a, b) => a[1].length - b[1].length)
  const used = new Set(), out = new Array(sets.length).fill(null)
  const bt = k => {
    if (k === order.length) return true
    const [i, set] = order[k]
    for (const id of set) { if (used.has(id)) continue; used.add(id); out[i] = id; if (bt(k + 1)) return true; used.delete(id); out[i] = null }
    return false
  }
  return bt(0) ? out : null
}

// Seat a whole party at one start time. party = [{ service:{id,duration_minutes},
// staffPref }]. Returns staffIds aligned to party order, or null if the group
// can't all be seated by distinct free therapists.
export function assignPartyAt(ctx, party, startUnix) {
  const sets = []
  for (const p of party) {
    const set = freeStaffFor(ctx, p.service.id, p.service.duration_minutes * 60, startUnix, p.staffPref)
    if (!set.length) return null
    sets.push(set)
  }
  return matchAssign(sets)
}

// Start times on a date where the WHOLE party fits simultaneously.
// party = [{ serviceId, staffPref }]. Returns [{ unix, display }].
export async function groupSlotsForDate(db, shop, party, dateStr) {
  const ctx = await dayContext(db, shop, dateStr)
  if (ctx.shopClosed) return []
  const wins = Object.values(ctx.availByStaff)
  if (!wins.length) return []
  const svcIds = [...new Set(party.map(p => p.serviceId))]
  const durById = {}
  for (const s of ((await db.prepare(`SELECT id,duration_minutes FROM services WHERE shop_id=? AND is_active=1 AND id IN (${svcIds.map(() => '?').join(',')})`).bind(shop.id, ...svcIds).all()).results || []))
    durById[s.id] = s.duration_minutes
  const people = party.map(p => ({ service: { id: p.serviceId, duration_minutes: durById[p.serviceId] }, staffPref: p.staffPref }))
  if (people.some(p => !p.service.duration_minutes)) return []
  const interval = Math.max(5, Number(shop.slot_interval_minutes) || 15)
  const gridStartMin = Math.min(...wins.map(w => w.sMin)), gridEndMin = Math.max(...wins.map(w => w.eMin))
  const now = Math.floor(Date.now() / 1000) + 30 * 60
  const pad = n => String(n).padStart(2, '0')
  const out = []
  for (let m = gridStartMin; m <= gridEndMin; m += interval) {
    const T = Math.floor(localToUtcMs(dateStr, `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, ctx.tz) / 1000)
    if (T < now) continue
    if (assignPartyAt(ctx, people, T)) {
      const h = Math.floor(m / 60)
      out.push({ unix: T, display: `${(h % 12) || 12}:${pad(m % 60)} ${h < 12 ? 'AM' : 'PM'}` })
    }
  }
  return out
}
