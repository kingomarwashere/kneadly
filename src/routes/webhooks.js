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

    // Prepaid package purchase → activate + set expiry.
    if (session.metadata?.kind === 'package') {
      const cpId = session.metadata.client_package_id
      const cp = cpId && await db.prepare('SELECT * FROM client_packages WHERE id=?').bind(cpId).first()
      if (cp && cp.status === 'pending_payment') {
        const pkg = await db.prepare('SELECT expiry_days FROM packages WHERE id=?').bind(cp.package_id).first()
        const now = Math.floor(Date.now() / 1000), expires = now + ((pkg?.expiry_days || 365) * 86400)
        let chargeId = null
        try { chargeId = (await stripeClient(c.env.STRIPE_SECRET_KEY).retrievePaymentIntent(session.payment_intent, { account })).latest_charge } catch (e) { console.error('pkg charge:', e.message) }
        await db.prepare("UPDATE client_packages SET status='active', activated_at=?, expires_at=?, stripe_session_id=?, stripe_payment_intent_id=?, stripe_charge_id=? WHERE id=?")
          .bind(now, expires, session.id, session.payment_intent, chargeId, cpId).run()
      }
      return c.json({ ok: true })
    }

    // Membership subscription started → activate + record subscription.
    if (session.metadata?.kind === 'membership') {
      const mId = session.metadata.membership_id
      const m = mId && await db.prepare('SELECT * FROM memberships WHERE id=?').bind(mId).first()
      if (m && m.status !== 'active') {
        let periodEnd = null
        try { periodEnd = (await stripeClient(c.env.STRIPE_SECRET_KEY).retrieveSubscription(session.subscription, { account })).current_period_end } catch (e) { console.error('sub retrieve:', e.message) }
        await db.prepare("UPDATE memberships SET status='active', stripe_subscription_id=?, stripe_customer_id=?, current_period_end=?, sessions_used=0 WHERE id=?")
          .bind(session.subscription || null, session.customer || m.stripe_customer_id || null, periodEnd, mId).run()
      }
      return c.json({ ok: true })
    }

    const bookingId = session.metadata?.booking_id
    if (!bookingId) return c.json({ ok: true })
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first()
    if (!booking) return c.json({ ok: true })

    // A "take payment" QR/link session (not a deposit) — record it in the ledger
    // (method: card) and keep the paid_cents aggregate in sync.
    if (session.metadata?.kind === 'balance') {
      const amt = session.amount_total || 0
      if (amt > 0) {
        await db.prepare('INSERT INTO payments (id, shop_id, booking_id, amount_cents, method, note) VALUES (?,?,?,?,?,?)')
          .bind(crypto.randomUUID().replace(/-/g, ''), booking.shop_id, bookingId, amt, 'card', 'Paid by QR (card/Apple/Google Pay)').run()
        await db.prepare('UPDATE bookings SET paid_cents = COALESCE(paid_cents,0) + ? WHERE id=?').bind(amt, bookingId).run()
      }
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

  // Membership subscription lifecycle.
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object
    const status = ['active', 'trialing'].includes(sub.status) ? 'active'
      : (['past_due', 'unpaid'].includes(sub.status) ? 'past_due' : (sub.status === 'canceled' ? 'canceled' : 'active'))
    await db.prepare('UPDATE memberships SET status=?, current_period_end=? WHERE stripe_subscription_id=?')
      .bind(status, sub.current_period_end || null, sub.id).run()
  }
  if (event.type === 'customer.subscription.deleted') {
    await db.prepare("UPDATE memberships SET status='canceled' WHERE stripe_subscription_id=?").bind(event.data.object.id).run()
  }
  // Each successful renewal resets the period's included sessions.
  if (event.type === 'invoice.paid') {
    const subId = event.data.object.subscription
    if (subId) await db.prepare("UPDATE memberships SET sessions_used=0, status='active' WHERE stripe_subscription_id=?").bind(subId).run()
  }

  return c.json({ ok: true })
})

export default app
