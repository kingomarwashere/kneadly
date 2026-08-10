// Transactional email via Resend. Sends are best-effort and NEVER throw — a
// booking must succeed even if email is down. bored.investments is a verified
// Resend domain; RESEND_API_KEY is a Worker secret, EMAIL_FROM a var.
import { t } from './i18n.js'
import { money } from './views.js'
import { formatBookingTime } from './slots.js'

const FROM_FALLBACK = 'Alisa <onboarding@resend.dev>'
const safe = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export async function sendEmail(env, { to, subject, html, text, replyTo }) {
  const key = env.RESEND_API_KEY
  if (!key) return { ok: false, error: 'no RESEND_API_KEY configured' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || FROM_FALLBACK,
        to: Array.isArray(to) ? to : [to],
        subject, html,
        ...(text ? { text } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    })
    if (!res.ok) return { ok: false, error: `resend ${res.status}: ${await res.text()}` }
    const data = await res.json()
    return { ok: true, id: data.id }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

// Shared branded shell around email body content.
function shell(accent, emoji, shopName, inner) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#faf8f5;font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#1c2b2a">
    <div style="max-width:520px;margin:0 auto;padding:28px 18px">
      <div style="font-size:20px;font-weight:800;margin-bottom:16px">💆 Alisa</div>
      <div style="background:#fff;border:1px solid #e8e2da;border-radius:16px;overflow:hidden">
        <div style="background:${accent};color:#fff;padding:22px 24px">
          <div style="font-size:1.8rem">${safe(emoji)}</div>
          <div style="font-weight:700;font-size:18px;margin-top:2px">${safe(shopName)}</div>
        </div>
        <div style="padding:24px">${inner}</div>
      </div>
      <p style="color:#9aa3b5;font-size:12px;margin-top:16px;text-align:center">Alisa · Online booking for massage shops</p>
    </div></body></html>`
}

function detailRow(label, value) {
  return `<tr>
    <td style="padding:9px 0;border-top:1px solid #eee;color:#6b7c7a;font-size:14px">${safe(label)}</td>
    <td style="padding:9px 0;border-top:1px solid #eee;text-align:right;font-weight:600;font-size:14px">${safe(value)}</td>
  </tr>`
}

// Localized confirmation for the customer.
export function bookingConfirmationEmail(lang, { shop, b, base }) {
  const accent = shop.accent || '#0f766e'
  const when = formatBookingTime(b.start_time, shop.timezone)
  const rows = [
    detailRow(t(lang, 'c_service'), b.service_name || ''),
    detailRow(t(lang, 'c_therapist'), b.staff_name || t(lang, 'our_team')),
    detailRow(t(lang, 'c_when'), when),
    detailRow(t(lang, 'c_price'), money(b.price_cents, shop.currency)),
    ...(b.deposit_cents > 0 ? [detailRow(t(lang, b.deposit_cents >= b.price_cents ? 'c_paid' : 'c_deposit_paid'), money(b.deposit_cents, shop.currency))] : []),
  ].join('')
  const url = `${base}/${shop.slug}/booked/${b.id}`
  const contact = shop.phone || shop.name

  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">✅ ${safe(t(lang, 'booked_in'))}</h1>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 4px">${safe(t(lang, 'email_hi', { name: b.customer_name }))}</p>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 18px">${safe(t(lang, 'done_sub', { shop: shop.name }))}</p>
    <div style="font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#6b7c7a;margin-bottom:2px">${safe(t(lang, 'email_details'))}</div>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <div style="margin-top:22px"><a href="${safe(url)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${safe(t(lang, 'email_view_booking'))} →</a></div>
    <p style="color:#6b7c7a;font-size:13px;margin:18px 0 0">${safe(t(lang, 'email_questions', { contact }))}</p>`

  const text = `${t(lang, 'booked_in')}\n${t(lang, 'done_sub', { shop: shop.name })}\n\n`
    + `${t(lang, 'c_service')}: ${b.service_name}\n${t(lang, 'c_therapist')}: ${b.staff_name || t(lang, 'our_team')}\n`
    + `${t(lang, 'c_when')}: ${when}\n${t(lang, 'c_price')}: ${money(b.price_cents, shop.currency)}\n`
    + (b.deposit_cents > 0 ? `${t(lang, b.deposit_cents >= b.price_cents ? 'c_paid' : 'c_deposit_paid')}: ${money(b.deposit_cents, shop.currency)}\n` : '')
    + `\n${url}\n${t(lang, 'email_questions', { contact })}`

  return { subject: t(lang, 'email_subject', { shop: shop.name }), html: shell(accent, shop.emoji, shop.name, inner), text }
}

// English notification for the shop owner (internal).
export function ownerNotificationEmail({ shop, b, base }) {
  const accent = shop.accent || '#0f766e'
  const when = formatBookingTime(b.start_time, shop.timezone)
  const rows = [
    detailRow('When', when),
    detailRow('Service', b.service_name || ''),
    detailRow('Therapist', b.staff_name || 'Our team'),
    detailRow('Client', b.customer_name),
    detailRow('Email', b.customer_email),
    ...(b.customer_phone ? [detailRow('Phone', b.customer_phone)] : []),
    detailRow('Price', money(b.price_cents, shop.currency)),
    ...(b.deposit_cents > 0 ? [detailRow('Deposit paid', money(b.deposit_cents, shop.currency))] : []),
  ].join('')
  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">📅 New booking</h1>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 18px"><strong>${safe(b.customer_name)}</strong> just booked <strong>${safe(b.service_name)}</strong>.</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    ${b.notes ? `<p style="color:#6b7c7a;font-size:13px;margin:14px 0 0">📝 ${safe(b.notes)}</p>` : ''}
    <div style="margin-top:20px"><a href="${safe(base)}/dashboard/roster" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:999px">Open roster →</a></div>`
  const text = `New booking at ${shop.name}\n\n${b.customer_name} booked ${b.service_name}\nWhen: ${when}\n`
    + `Therapist: ${b.staff_name || 'Our team'}\nClient: ${b.customer_name} · ${b.customer_email}${b.customer_phone ? ' · ' + b.customer_phone : ''}\n`
    + `Price: ${money(b.price_cents, shop.currency)}${b.deposit_cents > 0 ? ` · Deposit paid: ${money(b.deposit_cents, shop.currency)}` : ''}\n`
    + `${b.notes ? `Notes: ${b.notes}\n` : ''}\nRoster: ${base}/dashboard/roster`
  return { subject: `New booking: ${b.service_name} — ${when}`, html: shell(accent, shop.emoji, shop.name, inner), text }
}

// Localized "how was your visit?" review request for the customer.
export function reviewRequestEmail(lang, { shop, b, base }) {
  const accent = shop.accent || '#0f766e'
  const url = `${base}/${shop.slug}/review/${b.id}`
  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">⭐ ${safe(t(lang, 'email_review_head'))}</h1>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 4px">${safe(t(lang, 'email_hi', { name: b.customer_name }))}</p>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 18px">${safe(t(lang, 'email_review_intro', { shop: shop.name }))}</p>
    <div><a href="${safe(url)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:999px">${safe(t(lang, 'email_review_btn'))} ★</a></div>`
  const text = `${t(lang, 'email_review_head')}\n${t(lang, 'email_review_intro', { shop: shop.name })}\n\n${t(lang, 'email_review_btn')}: ${url}`
  return { subject: t(lang, 'email_review_subject', { shop: shop.name }), html: shell(accent, shop.emoji, shop.name, inner), text }
}

// Ask the customer for a review after their visit (best-effort).
export async function sendReviewRequest(env, bookingId) {
  try {
    const db = env.DB
    const b = await db.prepare('SELECT * FROM bookings WHERE id=?').bind(bookingId).first()
    if (!b || !b.customer_email) return
    // Don't ask twice.
    const existing = await db.prepare('SELECT id FROM reviews WHERE booking_id=?').bind(bookingId).first()
    if (existing) return
    const shop = await db.prepare('SELECT * FROM shops WHERE id=?').bind(b.shop_id).first()
    if (!shop) return
    const base = env.BASE_URL || 'https://alisa.bored.investments'
    const m = reviewRequestEmail(b.lang || 'en', { shop, b, base })
    const r = await sendEmail(env, { to: b.customer_email, subject: m.subject, html: m.html, text: m.text, replyTo: shop.email || undefined })
    if (!r.ok) console.error('review request failed:', r.error)
  } catch (e) {
    console.error('sendReviewRequest failed:', String(e))
  }
}

// Invite a therapist the owner just added (English — therapist's lang unknown).
export function therapistInviteEmail({ shop, staff, base }) {
  const accent = shop.accent || '#0f766e'
  const linkUrl = `${base}/t/${staff.token}`
  const accountUrl = `${base}/pro/signup?claim=${staff.token}`
  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">👋 You've been added to ${safe(shop.name)}</h1>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 16px">Hi ${safe(staff.name.split(' ')[0])}, <strong>${safe(shop.name)}</strong> added you as a therapist on Alisa. Set your own working hours and days off from your private scheduling link:</p>
    <div><a href="${safe(linkUrl)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Open my schedule →</a></div>
    <p style="color:#6b7c7a;font-size:14px;margin:20px 0 8px">Work at more than one shop? Create one login to manage them all in one place:</p>
    <div><a href="${safe(accountUrl)}" style="display:inline-block;background:#fff;color:${accent};border:1px solid ${accent};text-decoration:none;font-weight:600;padding:11px 20px;border-radius:999px">Create my therapist account →</a></div>
    <p style="color:#9aa3b5;font-size:12px;margin:20px 0 0">🔒 Keep your scheduling link private — anyone with it can change your hours.</p>`
  const text = `You've been added to ${shop.name} on Alisa.\n\n`
    + `Set your hours & days off: ${linkUrl}\n\nWork at more than one shop? Create one login: ${accountUrl}\n\nKeep your link private.`
  return { subject: `You've been added to ${shop.name} on Alisa`, html: shell(accent, shop.emoji, shop.name, inner), text }
}

export async function sendTherapistInvite(env, staffId) {
  try {
    const db = env.DB
    const staff = await db.prepare('SELECT * FROM staff WHERE id=?').bind(staffId).first()
    if (!staff || !staff.email) return
    const shop = await db.prepare('SELECT * FROM shops WHERE id=?').bind(staff.shop_id).first()
    if (!shop) return
    const base = env.BASE_URL || 'https://alisa.bored.investments'
    const m = therapistInviteEmail({ shop, staff, base })
    const r = await sendEmail(env, { to: staff.email, subject: m.subject, html: m.html, text: m.text, replyTo: shop.email || undefined })
    if (!r.ok) console.error('therapist invite failed:', r.error)
  } catch (e) {
    console.error('sendTherapistInvite failed:', String(e))
  }
}

// Localized cancellation (with refund note) for the customer.
export function cancellationEmail(lang, { shop, b, base }) {
  const accent = shop.accent || '#0f766e'
  const when = formatBookingTime(b.start_time, shop.timezone)
  const refunded = b.deposit_cents > 0 && b.refunded_at
  const rows = [
    detailRow(t(lang, 'c_service'), b.service_name || ''),
    detailRow(t(lang, 'c_when'), when),
  ].join('')
  const contact = shop.phone || shop.name
  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">🚫 ${safe(t(lang, 'email_cancelled_head'))}</h1>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 4px">${safe(t(lang, 'email_hi', { name: b.customer_name }))}</p>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 16px">${safe(t(lang, 'email_cancel_intro'))}</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    ${refunded ? `<p style="color:#2f8a5b;font-size:14px;margin:16px 0 0">💳 ${safe(t(lang, 'email_refunded', { amount: money(b.deposit_cents, shop.currency) }))}</p>` : ''}
    <div style="margin-top:22px"><a href="${safe(base)}/${safe(shop.slug)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${safe(shop.name)} →</a></div>
    <p style="color:#6b7c7a;font-size:13px;margin:18px 0 0">${safe(t(lang, 'email_questions', { contact }))}</p>`
  const text = `${t(lang, 'email_cancelled_head')}\n${t(lang, 'email_cancel_intro')}\n\n`
    + `${t(lang, 'c_service')}: ${b.service_name}\n${t(lang, 'c_when')}: ${when}\n`
    + (refunded ? `\n${t(lang, 'email_refunded', { amount: money(b.deposit_cents, shop.currency) })}\n` : '')
    + `\n${base}/${shop.slug}`
  return { subject: t(lang, 'email_cancel_subject', { shop: shop.name }), html: shell(accent, shop.emoji, shop.name, inner), text }
}

// Localized day-before reminder for the customer.
export function reminderEmail(lang, { shop, b, base }) {
  const accent = shop.accent || '#0f766e'
  const when = formatBookingTime(b.start_time, shop.timezone)
  const rows = [
    detailRow(t(lang, 'c_service'), b.service_name || ''),
    detailRow(t(lang, 'c_therapist'), b.staff_name || t(lang, 'our_team')),
    detailRow(t(lang, 'c_when'), when),
  ].join('')
  const url = `${base}/${shop.slug}/booked/${b.id}`
  const contact = shop.phone || shop.name
  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">⏰ ${safe(t(lang, 'email_reminder_head'))}</h1>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 4px">${safe(t(lang, 'email_hi', { name: b.customer_name }))}</p>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 16px">${safe(t(lang, 'email_reminder_intro', { shop: shop.name }))}</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <div style="margin-top:22px"><a href="${safe(url)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${safe(t(lang, 'email_view_booking'))} →</a></div>
    <p style="color:#6b7c7a;font-size:13px;margin:18px 0 0">${safe(t(lang, 'email_questions', { contact }))}</p>`
  const text = `${t(lang, 'email_reminder_head')}\n${t(lang, 'email_reminder_intro', { shop: shop.name })}\n\n`
    + `${t(lang, 'c_service')}: ${b.service_name}\n${t(lang, 'c_therapist')}: ${b.staff_name || t(lang, 'our_team')}\n${t(lang, 'c_when')}: ${when}\n`
    + `\n${url}\n${t(lang, 'email_questions', { contact })}`
  return { subject: t(lang, 'email_reminder_subject', { shop: shop.name }), html: shell(accent, shop.emoji, shop.name, inner), text }
}

// Localized "your appointment was moved" email for the customer.
export function rescheduleEmail(lang, { shop, b, base }) {
  const accent = shop.accent || '#0f766e'
  const when = formatBookingTime(b.start_time, shop.timezone)
  const rows = [
    detailRow(t(lang, 'c_service'), b.service_name || ''),
    detailRow(t(lang, 'c_therapist'), b.staff_name || t(lang, 'our_team')),
    detailRow(t(lang, 'c_when'), when),
  ].join('')
  const url = `${base}/${shop.slug}/booked/${b.id}`
  const contact = shop.phone || shop.name
  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">🔄 ${safe(t(lang, 'email_rescheduled_head'))}</h1>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 4px">${safe(t(lang, 'email_hi', { name: b.customer_name }))}</p>
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 16px">${safe(t(lang, 'email_reschedule_intro'))}</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <div style="margin-top:22px"><a href="${safe(url)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${safe(t(lang, 'email_view_booking'))} →</a></div>
    <p style="color:#6b7c7a;font-size:13px;margin:18px 0 0">${safe(t(lang, 'email_questions', { contact }))}</p>`
  const text = `${t(lang, 'email_rescheduled_head')}\n${t(lang, 'email_reschedule_intro')}\n\n`
    + `${t(lang, 'c_service')}: ${b.service_name}\n${t(lang, 'c_therapist')}: ${b.staff_name || t(lang, 'our_team')}\n${t(lang, 'c_when')}: ${when}\n`
    + `\n${url}\n${t(lang, 'email_questions', { contact })}`
  return { subject: t(lang, 'email_reschedule_subject', { shop: shop.name }), html: shell(accent, shop.emoji, shop.name, inner), text }
}

// Email the customer that their booking moved to a new time (best-effort).
export async function sendRescheduleEmail(env, bookingId) {
  try {
    const db = env.DB
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first()
    if (!b || !b.customer_email || b.status === 'cancelled') return
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').bind(b.shop_id).first()
    if (!shop) return
    const base = env.BASE_URL || 'https://alisa.bored.investments'
    const m = rescheduleEmail(b.lang || 'en', { shop, b, base })
    const r = await sendEmail(env, { to: b.customer_email, subject: m.subject, html: m.html, text: m.text, replyTo: shop.email || undefined })
    if (!r.ok) console.error('reschedule email failed:', r.error)
  } catch (e) {
    console.error('sendRescheduleEmail failed:', String(e))
  }
}

// Email the customer that their booking was cancelled (best-effort).
export async function sendCancellationEmail(env, bookingId) {
  try {
    const db = env.DB
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first()
    if (!b || b.status !== 'cancelled' || !b.customer_email) return
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').bind(b.shop_id).first()
    if (!shop) return
    const base = env.BASE_URL || 'https://alisa.bored.investments'
    const m = cancellationEmail(b.lang || 'en', { shop, b, base })
    const r = await sendEmail(env, { to: b.customer_email, subject: m.subject, html: m.html, text: m.text, replyTo: shop.email || undefined })
    if (!r.ok) console.error('cancellation email failed:', r.error)
  } catch (e) {
    console.error('sendCancellationEmail failed:', String(e))
  }
}

// Cron entrypoint: send day-before reminders for confirmed bookings ~1 day out
// that haven't been reminded. reminder_sent_at guards against duplicates.
export async function runReminders(env) {
  try {
    const db = env.DB
    const now = Math.floor(Date.now() / 1000)
    const rows = (await db.prepare(
      `SELECT * FROM bookings WHERE status = 'confirmed' AND reminder_sent_at IS NULL
       AND start_time > ? AND start_time < ?`
    ).bind(now + 3600, now + 34 * 3600).all()).results || []
    const base = env.BASE_URL || 'https://alisa.bored.investments'
    let sent = 0
    for (const b of rows) {
      const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').bind(b.shop_id).first()
      if (shop && b.customer_email) {
        const m = reminderEmail(b.lang || 'en', { shop, b, base })
        const r = await sendEmail(env, { to: b.customer_email, subject: m.subject, html: m.html, text: m.text, replyTo: shop.email || undefined })
        if (r.ok) sent++; else console.error('reminder email failed:', r.error)
      }
      await db.prepare('UPDATE bookings SET reminder_sent_at = ? WHERE id = ?').bind(now, b.id).run()
    }
    console.log(`runReminders: ${rows.length} due, ${sent} sent`)
    return sent
  } catch (e) {
    console.error('runReminders failed:', String(e))
    return 0
  }
}

// Load a confirmed booking and email both the customer (localized) and the shop
// owner (English). Best-effort: swallows all errors.
export async function sendBookingEmails(env, bookingId) {
  try {
    const db = env.DB
    const b = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first()
    if (!b || !(b.status === 'confirmed' || b.status === 'completed')) return
    const shop = await db.prepare('SELECT * FROM shops WHERE id = ?').bind(b.shop_id).first()
    if (!shop) return
    const base = env.BASE_URL || 'https://alisa.bored.investments'
    const lang = b.lang || 'en'

    if (b.customer_email) {
      const m = bookingConfirmationEmail(lang, { shop, b, base })
      const r = await sendEmail(env, { to: b.customer_email, subject: m.subject, html: m.html, text: m.text, replyTo: shop.email || undefined })
      if (!r.ok) console.error('customer email failed:', r.error)
    }
    const owner = await db.prepare('SELECT email FROM users WHERE id = ?').bind(shop.owner_id).first()
    const ownerTo = owner?.email || shop.email
    if (ownerTo) {
      const m = ownerNotificationEmail({ shop, b, base })
      const r = await sendEmail(env, { to: ownerTo, subject: m.subject, html: m.html, text: m.text, replyTo: b.customer_email || undefined })
      if (!r.ok) console.error('owner email failed:', r.error)
    }
  } catch (e) {
    console.error('sendBookingEmails failed:', String(e))
  }
}

// ─── Gift cards ──────────────────────────────────────────────────────────────
function giftCardBody(lang, { shop, card, base, forRecipient }) {
  const accent = shop.accent || '#0f766e'
  const expiry = card.expires_at ? formatBookingTime(card.expires_at, shop.timezone).split(',').slice(0, 2).join(',') : t(lang, 'gift_no_expiry')
  const greetName = forRecipient ? (card.recipient_name || '') : (card.purchaser_name || '')
  const intro = forRecipient
    ? t(lang, 'gift_email_recipient_intro', { from: card.purchaser_name || t(lang, 'gift_someone'), shop: shop.name })
    : t(lang, 'gift_email_buyer_intro', { shop: shop.name })
  const msg = forRecipient && card.message
    ? `<div style="background:#faf7f0;border-radius:12px;padding:14px 16px;margin:0 0 18px;font-style:italic;color:#5b4a2e">“${safe(card.message)}”</div>` : ''
  const inner = `
    <h1 style="font-size:20px;margin:0 0 6px">🎁 ${safe(t(lang, 'gift_email_head'))}</h1>
    ${greetName ? `<p style="color:#6b7c7a;font-size:14px;margin:0 0 4px">${safe(t(lang, 'email_hi', { name: greetName }))}</p>` : ''}
    <p style="color:#6b7c7a;font-size:14px;margin:0 0 18px">${safe(intro)}</p>
    ${msg}
    <div style="text-align:center;border:2px dashed ${accent};border-radius:14px;padding:20px;margin:0 0 18px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b7c7a">${safe(t(lang, 'gift_value'))}</div>
      <div style="font-size:30px;font-weight:800;color:${accent};margin:2px 0 10px">${safe(money(card.balance_cents, shop.currency))}</div>
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b7c7a">${safe(t(lang, 'gift_code'))}</div>
      <div style="font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:.06em;margin-top:2px">${safe(card.code)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse">
      ${detailRow(t(lang, 'gift_redeem_at'), shop.name)}
      ${detailRow(t(lang, 'gift_expires'), expiry)}
    </table>
    <p style="color:#6b7c7a;font-size:13px;margin:18px 0 0">${safe(t(lang, 'gift_email_how', { shop: shop.name }))}</p>`
  const text = `${t(lang, 'gift_email_head')}\n${intro}\n\n${t(lang, 'gift_value')}: ${money(card.balance_cents, shop.currency)}\n${t(lang, 'gift_code')}: ${card.code}\n${t(lang, 'gift_redeem_at')}: ${shop.name}\n${t(lang, 'gift_expires')}: ${expiry}\n\n${t(lang, 'gift_email_how', { shop: shop.name })}`
  const subject = forRecipient
    ? t(lang, 'gift_email_recipient_subject', { shop: shop.name })
    : t(lang, 'gift_email_buyer_subject', { shop: shop.name })
  return { subject, html: shell(accent, '🎁', shop.name, inner), text }
}

// Email the purchaser their receipt+code, and (if given) the recipient their gift.
export async function sendGiftCardEmails(env, cardId) {
  try {
    const db = env.DB
    const card = await db.prepare('SELECT * FROM gift_cards WHERE id=?').bind(cardId).first()
    if (!card || card.status === 'void' || card.status === 'pending_payment') return
    const shop = await db.prepare('SELECT * FROM shops WHERE id=?').bind(card.shop_id).first()
    if (!shop) return
    const base = env.BASE_URL || 'https://alisa.bored.investments'
    const lang = card.lang || 'en'
    if (card.purchaser_email) {
      const m = giftCardBody(lang, { shop, card, base, forRecipient: false })
      const r = await sendEmail(env, { to: card.purchaser_email, subject: m.subject, html: m.html, text: m.text, replyTo: shop.email || undefined })
      if (!r.ok) console.error('gift buyer email failed:', r.error)
    }
    if (card.recipient_email && card.recipient_email !== card.purchaser_email) {
      const m = giftCardBody(lang, { shop, card, base, forRecipient: true })
      const r = await sendEmail(env, { to: card.recipient_email, subject: m.subject, html: m.html, text: m.text, replyTo: card.purchaser_email || shop.email || undefined })
      if (!r.ok) console.error('gift recipient email failed:', r.error)
    }
  } catch (e) {
    console.error('sendGiftCardEmails failed:', String(e))
  }
}
