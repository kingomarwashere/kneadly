import { genId } from './auth.js'

// Unambiguous alphabet — no 0/O/1/I/L to keep hand-typed codes reliable.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const YEAR_SECS = 365 * 24 * 3600

function randChunk(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  let s = ''
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length]
  return s
}

// A friendly code like SER-4F9K-QP2M (prefix from the shop slug).
export async function generateGiftCode(db, slug) {
  const prefix = (slug || 'GIFT').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')
  for (let i = 0; i < 8; i++) {
    const code = `${prefix}-${randChunk(4)}-${randChunk(4)}`
    const clash = await db.prepare('SELECT 1 FROM gift_cards WHERE code=?').bind(code).first()
    if (!clash) return code
  }
  // Extremely unlikely fallback — add more entropy.
  return `${prefix}-${randChunk(4)}-${randChunk(4)}-${randChunk(4)}`
}

// Normalise user input: uppercase, strip spaces, tolerate missing dashes.
export function normalizeCode(raw) {
  return (raw || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Look a card up by code within a shop, tolerant of dashes/case.
export async function findGiftCard(db, shopId, rawCode) {
  const norm = normalizeCode(rawCode)
  if (!norm) return null
  const rows = (await db.prepare('SELECT * FROM gift_cards WHERE shop_id=?').bind(shopId).all()).results || []
  return rows.find(r => normalizeCode(r.code) === norm) || null
}

// Is a card usable right now? Returns { ok } or { ok:false, reason }.
export function redeemableState(card, nowSec) {
  if (!card) return { ok: false, reason: 'not_found' }
  if (card.status === 'void') return { ok: false, reason: 'void' }
  if (card.status === 'pending_payment') return { ok: false, reason: 'pending' }
  if ((card.balance_cents || 0) <= 0) return { ok: false, reason: 'empty' }
  if (card.expires_at && nowSec > card.expires_at) return { ok: false, reason: 'expired' }
  return { ok: true }
}

// Atomically redeem up to `want` cents. Uses a conditional UPDATE so two
// concurrent bookings can never overspend the same card. Returns cents applied.
export async function redeemGift(db, card, want, bookingId, note) {
  const amount = Math.min(Math.max(0, want | 0), card.balance_cents || 0)
  if (amount <= 0) return 0
  const res = await db.prepare(
    "UPDATE gift_cards SET balance_cents = balance_cents - ?, status = CASE WHEN balance_cents - ? <= 0 THEN 'redeemed' ELSE 'active' END WHERE id=? AND status IN ('active','redeemed') AND balance_cents >= ?"
  ).bind(amount, amount, card.id, amount).run()
  if (!res.meta || res.meta.changes < 1) return 0   // lost the race / state changed
  await db.prepare('INSERT INTO gift_card_txns (id, gift_card_id, booking_id, amount_cents, note) VALUES (?, ?, ?, ?, ?)')
    .bind(genId(), card.id, bookingId || null, -amount, note || 'Redeemed on booking').run()
  return amount
}

// Put credit back (booking cancelled). Reactivates a fully-redeemed card.
export async function restoreGiftForBooking(db, bookingId) {
  const b = await db.prepare('SELECT gift_card_id, gift_applied FROM bookings WHERE id=?').bind(bookingId).first()
  if (!b || !b.gift_card_id || !(b.gift_applied > 0)) return 0
  const card = await db.prepare("SELECT * FROM gift_cards WHERE id=?").bind(b.gift_card_id).first()
  if (!card || card.status === 'void') return 0
  await db.prepare("UPDATE gift_cards SET balance_cents = balance_cents + ?, status = CASE WHEN status='redeemed' THEN 'active' ELSE status END WHERE id=?")
    .bind(b.gift_applied, card.id).run()
  await db.prepare('INSERT INTO gift_card_txns (id, gift_card_id, booking_id, amount_cents, note) VALUES (?, ?, ?, ?, ?)')
    .bind(genId(), card.id, bookingId, b.gift_applied, 'Restored — booking cancelled').run()
  return b.gift_applied
}
