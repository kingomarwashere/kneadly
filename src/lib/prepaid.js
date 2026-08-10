import { genId } from './auth.js'
import { normalizeCode } from './giftcard.js'

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function randChunk(n) {
  const b = crypto.getRandomValues(new Uint8Array(n))
  let s = ''; for (const x of b) s += ALPHABET[x % ALPHABET.length]; return s
}

// PKG-XXXX-XXXX style code, unique across client_packages.
export async function generatePackageCode(db, slug) {
  const prefix = (slug || 'PKG').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase().padEnd(3, 'X')
  for (let i = 0; i < 8; i++) {
    const code = `${prefix}-${randChunk(4)}-${randChunk(4)}`
    if (!(await db.prepare('SELECT 1 FROM client_packages WHERE code=?').bind(code).first())) return code
  }
  return `${prefix}-${randChunk(4)}-${randChunk(4)}-${randChunk(4)}`
}

export async function findClientPackage(db, shopId, rawCode) {
  const norm = normalizeCode(rawCode)
  if (!norm) return null
  const rows = (await db.prepare("SELECT * FROM client_packages WHERE shop_id=? AND status IN ('active')").bind(shopId).all()).results || []
  return rows.find(r => normalizeCode(r.code) === norm) || null
}

export function packageUsable(pkg, nowSec) {
  if (!pkg || pkg.status !== 'active') return { ok: false, reason: 'not_active' }
  if (pkg.sessions_used >= pkg.sessions_total) return { ok: false, reason: 'used_up' }
  if (pkg.expires_at && nowSec > pkg.expires_at) return { ok: false, reason: 'expired' }
  return { ok: true }
}

// Consume one session atomically and mark the booking as covered.
export async function redeemPackageSession(db, pkg, bookingId) {
  const res = await db.prepare(
    "UPDATE client_packages SET sessions_used = sessions_used + 1, status = CASE WHEN sessions_used + 1 >= sessions_total THEN 'used' ELSE 'active' END WHERE id=? AND status='active' AND sessions_used < sessions_total"
  ).bind(pkg.id).run()
  if (!res.meta || res.meta.changes < 1) return false
  await db.prepare("UPDATE bookings SET covered_by='package' WHERE id=?").bind(bookingId).run()
  return true
}

// Active membership for a client (by client_id or email).
export async function activeMembership(db, shopId, clientId, email) {
  return db.prepare(
    "SELECT * FROM memberships WHERE shop_id=? AND status='active' AND (client_id=? OR (?<>'' AND lower(email)=lower(?))) ORDER BY created_at DESC LIMIT 1"
  ).bind(shopId, clientId || '', email || '', email || '').first()
}
