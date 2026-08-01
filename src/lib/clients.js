// Saved clients: find an existing client for a shop (by email, then phone),
// creating one if none matches. Keeps a client's contact details fresh.
import { genId } from './auth.js'

export async function findOrCreateClient(db, shopId, { name, email, phone } = {}) {
  name = (name || '').toString().trim()
  email = (email || '').toString().trim().toLowerCase()
  phone = (phone || '').toString().trim()

  let existing = null
  if (email) existing = await db.prepare('SELECT * FROM clients WHERE shop_id=? AND lower(email)=?').bind(shopId, email).first()
  if (!existing && phone) existing = await db.prepare('SELECT * FROM clients WHERE shop_id=? AND phone=?').bind(shopId, phone).first()

  if (existing) {
    // Fill in any newly-provided contact details without clobbering existing ones.
    const nm = name || existing.name, em = email || existing.email, ph = phone || existing.phone
    if (nm !== existing.name || em !== existing.email || ph !== existing.phone) {
      await db.prepare('UPDATE clients SET name=?, email=?, phone=?, updated_at=unixepoch() WHERE id=?')
        .bind(nm, em || null, ph || null, existing.id).run()
    }
    return existing.id
  }

  if (!name && !email && !phone) return null
  const id = genId()
  await db.prepare('INSERT INTO clients (id, shop_id, name, email, phone) VALUES (?, ?, ?, ?, ?)')
    .bind(id, shopId, name || 'Walk-in', email || null, phone || null).run()
  return id
}
