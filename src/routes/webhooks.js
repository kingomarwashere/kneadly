import { Hono } from 'hono'
import { stripeClient } from '../lib/stripe.js'
import { sendBookingEmails } from '../lib/email.js'

const app = new Hono()

app.post('/stripe', async (c) => {
  const sig = c.req.header('stripe-signature')
  if (!sig) return c.json({ error: 'No signature' }, 400)
  const payload = await c.req.text()

  let event
  try {
    event = await stripeClient(c.env.STRIPE_SECRET_KEY).verifyWebhook(payload, sig, c.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Webhook verification failed:', err.message)
    return c.json({ error: 'Invalid signature' }, 400)
  }

  const db = c.env.DB

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const bookingId = session.metadata?.booking_id
    if (!bookingId) return c.json({ ok: true })
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first()
    if (!booking) return c.json({ ok: true })

    let chargeId = null
    try {
      const pi = await stripeClient(c.env.STRIPE_SECRET_KEY).retrievePaymentIntent(session.payment_intent)
      chargeId = pi.latest_charge
    } catch (err) { console.error('charge lookup failed:', err.message) }

    await db.prepare(
      "UPDATE bookings SET status = 'confirmed', stripe_session_id = ?, stripe_payment_intent_id = ?, stripe_charge_id = ? WHERE id = ?"
    ).bind(session.id, session.payment_intent, chargeId, bookingId).run()

    // Group booking: the single deposit covers every guest — confirm them all.
    const emailIds = [bookingId]
    if (booking.group_id) {
      const siblings = (await db.prepare("SELECT id FROM bookings WHERE group_id=? AND id<>? AND status='pending_payment'").bind(booking.group_id, bookingId).all()).results || []
      if (siblings.length) {
        await db.prepare("UPDATE bookings SET status='confirmed' WHERE group_id=? AND status='pending_payment'").bind(booking.group_id).run()
        for (const s of siblings) emailIds.push(s.id)
      }
    }

    // Deposit paid → email the customer(s) (localized) + owner. Non-blocking.
    const emailP = Promise.all(emailIds.map(id => sendBookingEmails(c.env, id)))
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(emailP); else await emailP
  }

  if (event.type === 'checkout.session.expired') {
    const meta = event.data.object.metadata || {}
    if (meta.group_id) {
      await db.prepare("UPDATE bookings SET status='cancelled' WHERE group_id=? AND status='pending_payment'").bind(meta.group_id).run()
    } else if (meta.booking_id) {
      await db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND status='pending_payment'").bind(meta.booking_id).run()
    }
  }

  return c.json({ ok: true })
})

export default app
