// Configurable per-shop loyalty: every N completed visits earns a reward
// (a fixed amount or a percentage off a booking).
import { money } from './views.js'

export const loyaltyLabel = (shop) =>
  shop.loyalty_type === 'percent' ? `${shop.loyalty_value}% off` : `${money(shop.loyalty_value, shop.currency)} off`

// Discount (cents) a reward gives on a booking of `priceCents`.
export function loyaltyReward(shop, priceCents) {
  if (shop.loyalty_type === 'percent') return Math.round((priceCents || 0) * (shop.loyalty_value || 0) / 100)
  return Math.min(priceCents || 0, shop.loyalty_value || 0)
}

// Loyalty standing for a client: completed visits, rewards earned/redeemed/available,
// and progress toward the next reward.
export async function loyaltyStatus(db, shop, client) {
  if (!shop.loyalty_enabled || !client) return { enabled: false }
  const threshold = Math.max(1, shop.loyalty_threshold || 5)
  const row = await db.prepare("SELECT COUNT(*) n FROM bookings WHERE shop_id=? AND client_id=? AND status='completed'").bind(shop.id, client.id).first()
  const completed = row?.n || 0
  const earned = Math.floor(completed / threshold)
  const redeemed = client.loyalty_redeemed || 0
  const available = Math.max(0, earned - redeemed)
  const toward = completed % threshold
  return { enabled: true, threshold, completed, earned, redeemed, available, toward, remaining: threshold - toward, label: loyaltyLabel(shop) }
}

// available-reward count per client_id, computed in one query (for the booking form).
export async function loyaltyAvailByClient(db, shop) {
  if (!shop.loyalty_enabled) return {}
  const threshold = Math.max(1, shop.loyalty_threshold || 5)
  const rows = (await db.prepare(
    `SELECT b.client_id, COUNT(*) done, MAX(cl.loyalty_redeemed) redeemed
     FROM bookings b JOIN clients cl ON cl.id=b.client_id
     WHERE b.shop_id=? AND b.status='completed' AND b.client_id IS NOT NULL
     GROUP BY b.client_id`).bind(shop.id).all()).results || []
  const map = {}
  for (const r of rows) map[r.client_id] = Math.max(0, Math.floor((r.done || 0) / threshold) - (r.redeemed || 0))
  return map
}
