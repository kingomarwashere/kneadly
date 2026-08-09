import { Hono } from 'hono'
import { stripeClient } from '../lib/stripe.js'
import { sendBookingEmails, sendGiftCardEmails } from '../lib/email.js'

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
  // Connect direct charges arrive as events FROM the connected account.
  const account = event.account || null

  // Keep the shop's connected-account status fresh (charges/onboarding state).
  if (event.type === 'account.updated') {
    const acct = event.data.object
    await db.prepare('UPDATE shops SET stripe_charges_enabled=?, stripe_details_submitted=? WHERE stripe_account_id=?')
      .bind(acct.charges_enabled ? 1 : 0, acct.details_submitted ? 1 : 0, acct.id).run()
    return c.json({ ok: true })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object

    // Gift-card purchase → activate the card, set expiry, email buyer + recipient.
    if (session.metadata?.kind === 'giftcard') {
      const cardId = session.metadata.gift_card_id
      const card = cardId && await db.prepare('SELECT * FROM gift_cards WHERE id=?').bind(cardId).first()
      if (card && card.status === 'pending_payment') {
        const shop = await db.prepare('SELECT gift_card_expiry_years, timezone FROM shops WHERE id=?').bind(card.shop_id).first()
        const years = Math.max(3, shop?.gift_card_expiry_years || 3)
        const now = Math.floor(Date.now() / 1000)
        const expires = now + years * 365 * 24 * 3600
        let chargeId = null
        try { chargeId = (await stripeClient(c.env.STRIPE_SECRET_KEY).retrievePaymentIntent(session.payment_intent, { account })).latest_charge } catch (e) { console.error('gift charge lookup:', e.message) }
        await db.prepare("UPDATE gift_cards SET status='active', activated_at=?, expires_at=?, stripe_session_id=?, stripe_payment_intent_id=?, stripe_charge_id=? WHERE id=?")
          .bind(now, expires, session.id, session.payment_intent, chargeId, cardId).run()
        const p = sendGiftCardEmails(c.env, cardId)
        if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(p); else await p
      }
      return c.json({ ok: true })
    }

    const bookingId = session.metadata?.booking_id
    if (!bookingId) return c.json({ ok: true })
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first()
    if (!booking) return c.json({ ok: true })

    // A "take payment" QR/link session (not a deposit) — just record the amount.
    if (session.metadata?.kind === 'balance') {
      await db.prepare('UPDATE bookings SET paid_cents = COALESCE(paid_cents,0) + ? WHERE id=?').bind(session.amount_total || 0, bookingId).run()
      return c.json({ ok: true })
    }

    let chargeId = null
    try {
      const pi = await stripeClient(c.env.STRIPE_SECRET_KEY).retrievePaymentIntent(session.payment_intent, { account })
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
    if (meta.kind === 'giftcard' && meta.gift_card_id) {
      await db.prepare("UPDATE gift_cards SET status='void' WHERE id=? AND status='pending_payment'").bind(meta.gift_card_id).run()
    } else if (meta.group_id) {
      await db.prepare("UPDATE bookings SET status='cancelled' WHERE group_id=? AND status='pending_payment'").bind(meta.group_id).run()
    } else if (meta.booking_id) {
      await db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND status='pending_payment'").bind(meta.booking_id).run()
    }
  }

  return c.json({ ok: true })
})

export default app
