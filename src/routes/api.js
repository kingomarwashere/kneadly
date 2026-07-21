import { Hono } from 'hono'
import { getShopBySlug, slotsForDate, availableDates } from '../lib/booking.js'

const app = new Hono()

// GET /api/slots?shop=slug&service=ID&staff=ID|any&date=YYYY-MM-DD
app.get('/slots', async (c) => {
  const db = c.env.DB
  const { shop: slug, service: serviceId, staff = 'any', date } = c.req.query()
  const shop = await getShopBySlug(db, slug)
  if (!shop) return c.json({ error: 'shop not found' }, 404)
  const service = await db.prepare('SELECT * FROM services WHERE id = ? AND shop_id = ? AND is_active = 1')
    .bind(serviceId, shop.id).first()
  if (!service) return c.json({ error: 'service not found' }, 404)

  if (date) {
    const slots = await slotsForDate(db, shop, service, staff, date)
    return c.json({ slots: slots.map(s => ({ time: s.time, unix: s.unix, display: s.display })) })
  }
  const dates = await availableDates(db, shop, service, staff)
  return c.json({ dates })
})

export default app
