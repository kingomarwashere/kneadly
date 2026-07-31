export async function hashPassword(password) {
  const enc = new TextEncoder()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256)
  const toHex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  return toHex(salt.buffer) + ':' + toHex(bits)
}

export async function verifyPassword(password, hash) {
  const [saltHex, hashHex] = hash.split(':')
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)))
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256)
  const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
  return computed === hashHex
}

export const genId = () => crypto.randomUUID().replace(/-/g, '')

export async function createSession(db, userId) {
  const id = genId()
  const expires = Math.floor(Date.now() / 1000) + 86400 * 30
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(id, userId, expires).run()
  return id
}

export async function getSession(db, sessionId) {
  if (!sessionId) return null
  return db.prepare(
    'SELECT s.user_id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?'
  ).bind(sessionId, Math.floor(Date.now() / 1000)).first()
}

export async function deleteSession(db, sessionId) {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run()
}

// ─── Therapist login accounts (separate identity from shop owners) ───────────
export async function createTherapistSession(db, therapistId) {
  const id = genId()
  const expires = Math.floor(Date.now() / 1000) + 86400 * 30
  await db.prepare('INSERT INTO therapist_sessions (id, therapist_id, expires_at) VALUES (?, ?, ?)').bind(id, therapistId, expires).run()
  return id
}

export async function getTherapistSession(db, sessionId) {
  if (!sessionId) return null
  return db.prepare(
    'SELECT t.id, t.email, t.name FROM therapist_sessions s JOIN therapists t ON t.id = s.therapist_id WHERE s.id = ? AND s.expires_at > ?'
  ).bind(sessionId, Math.floor(Date.now() / 1000)).first()
}

export async function deleteTherapistSession(db, sessionId) {
  await db.prepare('DELETE FROM therapist_sessions WHERE id = ?').bind(sessionId).run()
}

// Link every staff row that carries this email (and isn't already claimed) to
// the therapist account — this is how one login spans multiple shops.
export async function claimStaffByEmail(db, therapistId, email) {
  await db.prepare(
    'UPDATE staff SET therapist_id = ? WHERE lower(email) = lower(?) AND (therapist_id IS NULL OR therapist_id = ?)'
  ).bind(therapistId, email, therapistId).run()
}
