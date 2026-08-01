// Convert a local date+time in a given timezone to UTC milliseconds
export function localToUtcMs(dateStr, timeStr, tz) {
  const utcDate = new Date(`${dateStr}T${timeStr}:00Z`)
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(utcDate)
  const get = t => parseInt(parts.find(p => p.type === t)?.value || '0')
  const localUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'))
  return utcDate.getTime() - (localUtcMs - utcDate.getTime())
}

export function getDayOfWeek(dateStr, tz) {
  const d = new Date(dateStr + 'T12:00:00Z')
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d)
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(name)
}

// Returns YYYY-MM-DD in a given timezone for a Date
export function dateTzString(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date)
}

// Generate available dates for the next N days
export function getAvailableDates(availability, tz, daysAhead = 60) {
  const dates = []
  const now = new Date()
  const todayStr = dateTzString(now, tz)
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date(now.getTime() + i * 86400000)
    const dateStr = dateTzString(d, tz)
    if (dateStr < todayStr) continue
    const dow = getDayOfWeek(dateStr, tz)
    if (availability.some(a => a.day_of_week === dow)) dates.push(dateStr)
  }
  return dates
}

// Generate time slots for a specific date given host availability and existing
// bookings. `stepMin` is how far apart offered start times are (e.g. 5, 15, 60).
export function generateSlots(avail, existingBookings, dateStr, durationMin, tz, stepMin = 15) {
  const [startH, startM] = avail.start_time.split(':').map(Number)
  const [endH, endM] = avail.end_time.split(':').map(Number)
  const startMin = startH * 60 + startM
  const endMin = endH * 60 + endM
  const step = Math.max(5, Number(stepMin) || 15)
  const nowMs = Date.now() + 30 * 60000 // 30 min booking lead time

  const slots = []
  for (let cur = startMin; cur + durationMin <= endMin; cur += step) {
    const h = Math.floor(cur / 60)
    const m = cur % 60
    const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    const slotStartMs = localToUtcMs(dateStr, timeStr, tz)
    const slotEndMs = slotStartMs + durationMin * 60000

    if (slotStartMs <= nowMs) continue

    const conflict = existingBookings.some(b => {
      const bS = b.start_time * 1000, bE = b.end_time * 1000
      return !(slotEndMs <= bS || slotStartMs >= bE)
    })
    if (conflict) continue

    const dH = h % 12 || 12
    const period = h >= 12 ? 'PM' : 'AM'
    slots.push({
      time: timeStr,
      unix: Math.floor(slotStartMs / 1000),
      display: `${dH}:${String(m).padStart(2, '0')} ${period}`
    })
  }
  return slots
}

export function formatBookingTime(unixTs, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(new Date(unixTs * 1000))
}

export function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}
