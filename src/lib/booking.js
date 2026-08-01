import { generateSlots, getDayOfWeek, dateTzString } from './slots.js'

export async function getShopBySlug(db, slug) {
  return db.prepare('SELECT * FROM shops WHERE slug = ?').bind(slug).first()
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
    const booked = await db.prepare(
      `SELECT start_time, end_time FROM bookings
       WHERE staff_id = ? AND status IN ('pending_payment','confirmed','completed')
       AND start_time BETWEEN ? AND ?`).bind(st.id, dayStart, dayEnd).all()
    const slots = generateSlots(avail, booked.results || [], dateStr, service.duration_minutes, shop.timezone, shop.slot_interval_minutes)
    for (const s of slots) {
      if (!byTime.has(s.time)) byTime.set(s.time, { ...s, staffIds: [] })
      byTime.get(s.time).staffIds.push(st.id)
    }
  }
  return [...byTime.values()].sort((a, b) => a.unix - b.unix)
}

// Dates within the next `daysAhead` that have at least one open slot pattern.
// A date qualifies only if some eligible therapist works that weekday AND has
// not marked that specific date as a day off.
export async function availableDates(db, shop, service, staffId, daysAhead = 45) {
  let staff = await eligibleStaff(db, shop.id, service.id)
  if (staffId && staffId !== 'any') staff = staff.filter(s => s.id === staffId)
  if (!staff.length) return []

  // Preload each therapist's working weekdays + booked-off dates once.
  const info = []
  for (const st of staff) {
    const dows = new Set(((await db.prepare('SELECT day_of_week FROM availability WHERE staff_id = ?').bind(st.id).all()).results || []).map(r => r.day_of_week))
    const off = new Set(((await db.prepare('SELECT date FROM time_off WHERE staff_id = ?').bind(st.id).all()).results || []).map(r => r.date))
    info.push({ dows, off })
  }

  const out = []
  const now = new Date()
  const todayStr = dateTzString(now, shop.timezone)
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date(now.getTime() + i * 86400000)
    const ds = dateTzString(d, shop.timezone)
    if (ds < todayStr) continue
    const dow = getDayOfWeek(ds, shop.timezone)
    if (info.some(x => x.dows.has(dow) && !x.off.has(ds))) out.push(ds)
  }
  return out
}
