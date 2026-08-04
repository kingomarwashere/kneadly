// Configurable multi-tier loyalty. Each shop defines reward tiers (milestones):
// e.g. 5 completed visits = $20 off, 10 = $50 off, 20 = 100% off. Each tier is a
// one-time reward per client; redemptions are tracked in loyalty_redemptions.
import { money } from './views.js'

export const tierLabel = (shop, tier) =>
  tier.type === 'percent' ? `${tier.value}% off` : `${money(tier.value, shop.currency)} off`

// Discount (cents) a tier gives on a booking of `priceCents`.
export function tierDiscount(tier, priceCents) {
  if (tier.type === 'percent') return Math.round((priceCents || 0) * (tier.value || 0) / 100)
  return Math.min(priceCents || 0, tier.value || 0)
}

export const getTiers = async (db, shopId) =>
  ((await db.prepare('SELECT visits,type,value FROM loyalty_tiers WHERE shop_id=? ORDER BY visits').bind(shopId).all()).results) || []

// A client's loyalty standing: completed visits + each tier's reached/redeemed/
// available state, the available rewards, and the next tier to work toward.
export async function loyaltyStatus(db, shop, client) {
  if (!shop.loyalty_enabled || !client) return { enabled: false, tiers: [], available: [] }
  const tiers = await getTiers(db, shop.id)
  if (!tiers.length) return { enabled: false, tiers: [], available: [] }
  const completed = (await db.prepare("SELECT COUNT(*) n FROM bookings WHERE shop_id=? AND client_id=? AND status='completed'").bind(shop.id, client.id).first())?.n || 0
  const redeemed = new Set(((await db.prepare('SELECT milestone FROM loyalty_redemptions WHERE client_id=?').bind(client.id).all()).results || []).map(r => r.milestone))
  const detailed = tiers.map(t => ({ ...t, label: tierLabel(shop, t), reached: completed >= t.visits, redeemed: redeemed.has(t.visits), available: completed >= t.visits && !redeemed.has(t.visits) }))
  return { enabled: true, completed, tiers: detailed, available: detailed.filter(t => t.available), next: detailed.find(t => !t.reached) }
}

// Map of client_id -> [{visits,label}] available rewards, for the booking form.
export async function loyaltyAvailByClient(db, shop) {
  if (!shop.loyalty_enabled) return {}
  const tiers = await getTiers(db, shop.id)
  if (!tiers.length) return {}
  const completedRows = (await db.prepare("SELECT client_id, COUNT(*) n FROM bookings WHERE shop_id=? AND status='completed' AND client_id IS NOT NULL GROUP BY client_id").bind(shop.id).all()).results || []
  const redRows = (await db.prepare('SELECT client_id, milestone FROM loyalty_redemptions WHERE shop_id=?').bind(shop.id).all()).results || []
  const redByClient = {}
  for (const r of redRows) (redByClient[r.client_id] ||= new Set()).add(r.milestone)
  const map = {}
  for (const cr of completedRows) {
    const done = cr.n, red = redByClient[cr.client_id] || new Set()
    const avail = tiers.filter(t => done >= t.visits && !red.has(t.visits)).map(t => ({ visits: t.visits, label: tierLabel(shop, t) }))
    if (avail.length) map[cr.client_id] = avail
  }
  return map
}
