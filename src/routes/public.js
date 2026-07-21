import { Hono } from 'hono'
import { layout, siteNav, money, esc } from '../lib/views.js'
import { getShopBySlug, eligibleStaff, slotsForDate } from '../lib/booking.js'
import { formatBookingTime, formatDate } from '../lib/slots.js'
import { stripeClient } from '../lib/stripe.js'
import { genId } from '../lib/auth.js'

const app = new Hono()

// Demo shops featured on the landing page so visitors can test the real flow
const DEMO_SLUGS = ['serenity-massage-bodywork', 'thai-lotus-massage']

// ─── Marketing landing ───────────────────────────────────────────────────────
app.get('/', async (c) => {
  const user = c.get('user')

  // Load featured demos (ignore any that have been removed)
  const placeholders = DEMO_SLUGS.map(() => '?').join(',')
  const demos = (await c.env.DB.prepare(
    `SELECT s.name, s.slug, s.tagline, s.emoji, s.accent, s.suburb, s.state,
       (SELECT COUNT(*) FROM services v WHERE v.shop_id = s.id AND v.is_active = 1) AS services,
       (SELECT COUNT(*) FROM staff t WHERE t.shop_id = s.id AND t.is_active = 1) AS staff,
       (SELECT MIN(price_cents) FROM services v WHERE v.shop_id = s.id AND v.is_active = 1) AS from_price,
       s.currency
     FROM shops s WHERE s.slug IN (${placeholders}) AND s.is_published = 1`
  ).bind(...DEMO_SLUGS).all()).results || []

  const demoSection = demos.length ? `
  <div class="wrap" style="padding:30px 20px 10px" id="try">
    <div style="text-align:center;margin-bottom:22px">
      <span class="pill">Try it — no signup</span>
      <h2 style="margin-top:12px">See a real booking page</h2>
      <p class="muted" style="max-width:520px;margin:0 auto">These are live example shops. Click through, pick a service and time, and make a test booking — exactly what your clients would do.</p>
    </div>
    <div class="grid g2">
      ${demos.map(d => `<a class="card svc" href="/${d.slug}" style="padding:0;overflow:hidden;text-decoration:none;color:inherit">
        <div style="padding:22px 24px;background:linear-gradient(135deg,${esc(d.accent)},#0b1f1d);color:#fff">
          <div style="font-size:2rem">${esc(d.emoji)}</div>
          <div style="font-family:'Fraunces',serif;font-size:1.35rem;font-weight:600;margin-top:4px">${esc(d.name)}</div>
          <div style="opacity:.85;font-size:.9rem">${esc([d.suburb, d.state].filter(Boolean).join(', '))}</div>
        </div>
        <div style="padding:16px 24px">
          ${d.tagline ? `<div style="margin-bottom:8px">${esc(d.tagline)}</div>` : ''}
          <div class="muted" style="font-size:.85rem">${d.services} services · ${d.staff} therapist${d.staff === 1 ? '' : 's'}${d.from_price != null ? ` · from ${money(d.from_price, d.currency)}` : ''}</div>
          <div class="btn sm" style="margin-top:14px">Book a test appointment →</div>
        </div>
      </a>`).join('')}
    </div>
    <p class="muted" style="text-align:center;font-size:.82rem;margin-top:16px">Want to see the owner side too? Log in with <strong>demo@kneadly.co</strong> / <strong>massage2026</strong> to explore a live dashboard.</p>
  </div>` : ''

  return c.html(layout('Kneadly — Online booking for massage shops', `
  ${siteNav(user)}
  <div class="wrap" style="text-align:center;padding:60px 20px 40px">
    <span class="pill">For massage &amp; bodywork shops</span>
    <h1 style="margin-top:18px">Let clients book you<br>straight from Google.</h1>
    <p class="muted" style="font-size:1.15rem;max-width:600px;margin:0 auto 28px">
      Your own booking page, deposits that stop no-shows, and a link you can drop
      into your Google Business Profile so customers book you from Maps.
    </p>
    <div class="row" style="justify-content:center;flex:0">
      <a class="btn gold" href="/signup">Create your booking page →</a>
      <a class="btn ghost" href="#try">Try a live demo</a>
    </div>
    <p class="muted" style="margin-top:14px;font-size:.85rem">Free to set up · No app to install · Live in 2 minutes</p>
  </div>

  ${demoSection}

  <div class="wrap grid g3" style="padding:20px 20px 10px" id="how">
    ${[
      ['🗓️', 'Book anytime', 'Clients pick a service, a therapist and a time. You wake up to a full calendar — no phone tag.'],
      ['💳', 'Deposits stop no-shows', 'Take a deposit at booking. If they cancel late, you keep it. If they show, it comes off the bill.'],
      ['📍', 'Right from Google Maps', 'Add your Kneadly link to your Google Business Profile. Customers tap “Book” on Maps and land on your page.'],
      ['🧖', 'Multiple therapists', 'Add your whole team, set each person’s hours, and let clients choose “anyone available”.'],
      ['⏱️', 'Set your own hours', 'Per-therapist weekly schedules. Kneadly only ever offers times you’re actually open.'],
      ['🔗', 'One shareable page', 'Put it in your Instagram bio, on flyers, in texts. Everything books through one clean link.'],
    ].map(([e, t, d]) => `<div class="card" style="padding:24px"><div style="font-size:2rem">${e}</div>
      <h3 style="margin:.5em 0 .2em;font-size:1.15rem">${t}</h3><p class="muted" style="margin:0">${d}</p></div>`).join('')}
  </div>

  <div class="wrap" style="padding:50px 20px">
    <div class="card" style="padding:34px;text-align:center;background:linear-gradient(135deg,#0f766e,#0b5750);color:#fff;border:none">
      <h2 style="color:#fff">Ready to fill your table?</h2>
      <p style="color:#a7d3ce;max-width:460px;margin:0 auto 22px">Set up your services and hours, then share your link. That’s it.</p>
      <a class="btn gold" href="/signup">Start free →</a>
    </div>
  </div>
  `, {
    jsonld: {
      '@context': 'https://schema.org', '@type': 'SoftwareApplication',
      name: 'Kneadly', applicationCategory: 'BusinessApplication',
      description: 'Online booking software for massage and bodywork businesses.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'AUD' }
    }
  }))
})

// ─── Shop public page ────────────────────────────────────────────────────────
app.get('/:slug', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop || !shop.is_published) return c.notFound()

  const services = (await db.prepare(
    'SELECT * FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const staff = (await db.prepare(
    'SELECT * FROM staff WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []

  const base = c.env.BASE_URL || 'https://kneadly.theradicalparty.com'
  const addr = [shop.address, shop.suburb, shop.state, shop.postcode].filter(Boolean).join(', ')

  const jsonld = {
    '@context': 'https://schema.org', '@type': 'HealthAndBeautyBusiness',
    name: shop.name, description: shop.about || shop.tagline || undefined,
    url: `${base}/${shop.slug}`, telephone: shop.phone || undefined,
    priceRange: services.length ? `${money(Math.min(...services.map(s => s.price_cents)), shop.currency)}–${money(Math.max(...services.map(s => s.price_cents)), shop.currency)}` : undefined,
    address: addr ? {
      '@type': 'PostalAddress', streetAddress: shop.address || undefined,
      addressLocality: shop.suburb || undefined, addressRegion: shop.state || undefined,
      postalCode: shop.postcode || undefined, addressCountry: 'AU'
    } : undefined,
    makesOffer: services.map(s => ({
      '@type': 'Offer', name: s.name,
      priceSpecification: { '@type': 'PriceSpecification', price: (s.price_cents / 100).toFixed(2), priceCurrency: shop.currency.toUpperCase() }
    })),
    potentialAction: {
      '@type': 'ReserveAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${base}/${shop.slug}/book`, actionPlatform: ['http://schema.org/DesktopWebPlatform', 'http://schema.org/MobileWebPlatform'] },
      result: { '@type': 'Reservation', name: `Booking at ${shop.name}` }
    }
  }

  const serviceCard = (s) => `
    <div class="card svc" style="padding:18px 20px;display:flex;justify-content:space-between;align-items:center;gap:14px">
      <div>
        <div style="font-weight:600">${esc(s.name)}</div>
        ${s.description ? `<div class="muted" style="font-size:.88rem">${esc(s.description)}</div>` : ''}
        <div class="muted" style="font-size:.85rem;margin-top:4px">⏱ ${s.duration_minutes} min · ${money(s.price_cents, shop.currency)}</div>
      </div>
      <a class="btn sm" href="/${shop.slug}/book?service=${s.id}">Book</a>
    </div>`

  return c.html(layout(`${shop.name} — Book online`, `
  ${siteNav(c.get('user'))}
  <div class="wrap" style="padding:14px 20px 0">
    <div class="card" style="padding:30px;background:linear-gradient(135deg,${esc(shop.accent)},#0b5750);color:#fff;border:none">
      <div style="font-size:2.6rem">${esc(shop.emoji)}</div>
      <h1 style="color:#fff;margin:.15em 0 .1em">${esc(shop.name)}</h1>
      ${shop.tagline ? `<p style="color:#d9ede9;margin:0 0 6px;font-size:1.05rem">${esc(shop.tagline)}</p>` : ''}
      <p style="color:#a7d3ce;margin:0;font-size:.9rem">${[addr, shop.phone].filter(Boolean).map(esc).join(' · ')}</p>
    </div>
  </div>

  <div class="wrap grid g2" style="padding:26px 20px;align-items:start">
    <div>
      <h2>Services</h2>
      ${services.length ? services.map(serviceCard).join('') : `<p class="muted">No services listed yet.</p>`}
    </div>
    <div>
      ${shop.about ? `<h2>About</h2><div class="card" style="padding:20px"><p class="muted" style="margin:0;white-space:pre-wrap">${esc(shop.about)}</p></div>` : ''}
      ${staff.length ? `<h2 style="margin-top:22px">Our therapists</h2>
        <div class="card" style="padding:8px 20px">
        ${staff.map(st => `<div style="padding:12px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center">
          <div style="font-size:1.6rem">${esc(st.emoji)}</div>
          <div><div style="font-weight:600">${esc(st.name)}</div><div class="muted" style="font-size:.85rem">${esc(st.title || '')}</div></div>
        </div>`).join('')}
        </div>` : ''}
    </div>
  </div>
  `, { accent: shop.accent, description: shop.tagline || `Book ${shop.name} online.`, jsonld }))
})

// ─── Booking flow ────────────────────────────────────────────────────────────
app.get('/:slug/book', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop || !shop.is_published) return c.notFound()

  const serviceId = c.req.query('service')
  const service = serviceId
    ? await db.prepare('SELECT * FROM services WHERE id = ? AND shop_id = ? AND is_active = 1').bind(serviceId, shop.id).first()
    : null

  // No service chosen → show the picker
  if (!service) {
    const services = (await db.prepare('SELECT * FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
    return c.html(layout(`Book — ${shop.name}`, `${siteNav(c.get('user'))}<div class="wrap narrow" style="padding:30px 20px">
      <a href="/${shop.slug}" class="muted">← ${esc(shop.name)}</a><h2 style="margin-top:10px">Choose a service</h2>
      ${services.map(s => `<a class="card svc" style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;text-decoration:none;color:inherit" href="/${shop.slug}/book?service=${s.id}">
        <div><div style="font-weight:600">${esc(s.name)}</div><div class="muted" style="font-size:.85rem">${s.duration_minutes} min · ${money(s.price_cents, shop.currency)}</div></div><span class="btn sm">Select</span></a>`).join('')}
      </div>`, { accent: shop.accent }))
  }

  const staff = await eligibleStaff(db, shop.id, service.id)
  const depositCents = Math.round(service.price_cents * shop.deposit_pct / 100)

  return c.html(layout(`Book ${service.name} — ${shop.name}`, `
  ${siteNav(c.get('user'))}
  <div class="wrap narrow" style="padding:26px 20px">
    <a href="/${shop.slug}" class="muted">← ${esc(shop.name)}</a>
    <div class="card" style="padding:26px;margin-top:12px">
      <div class="pill">${service.duration_minutes} min · ${money(service.price_cents, shop.currency)}</div>
      <h2 style="margin:.4em 0 0">${esc(service.name)}</h2>
      ${service.description ? `<p class="muted" style="margin:.3em 0 0">${esc(service.description)}</p>` : ''}

      <form method="post" action="/${shop.slug}/book" id="bk">
        <input type="hidden" name="service" value="${service.id}">
        <input type="hidden" name="start" id="start">

        <h3 style="margin:1.4em 0 .4em;font-size:1.05rem">1. Choose a therapist</h3>
        <select name="staff" id="staff">
          <option value="any">Anyone available</option>
          ${staff.map(s => `<option value="${s.id}">${esc(s.emoji)} ${esc(s.name)}</option>`).join('')}
        </select>

        <h3 style="margin:1.4em 0 .4em;font-size:1.05rem">2. Pick a date</h3>
        <div id="dates" class="row" style="gap:8px"><span class="muted">Loading…</span></div>

        <h3 style="margin:1.4em 0 .4em;font-size:1.05rem">3. Pick a time</h3>
        <div id="times" class="row" style="gap:8px"><span class="muted">Choose a date first.</span></div>

        <h3 style="margin:1.4em 0 .4em;font-size:1.05rem">4. Your details</h3>
        <div class="field"><label>Full name</label><input name="name" required></div>
        <div class="field"><label>Email</label><input type="email" name="email" required></div>
        <div class="field"><label>Mobile</label><input name="phone" placeholder="Optional"></div>
        <div class="field"><label>Anything we should know?</label><textarea name="notes" rows="2" placeholder="Injuries, pressure preference, parking…"></textarea></div>

        <div class="card" style="padding:14px 16px;background:#f6f2ec;border-style:dashed;margin-bottom:16px">
          ${depositCents > 0
            ? `💳 <strong>${money(depositCents, shop.currency)} deposit</strong> to confirm — the rest (${money(service.price_cents - depositCents, shop.currency)}) is paid in-store. Free cancellation up to ${shop.cancellation_hours}h before.`
            : `No deposit required — just confirm your spot.`}
        </div>

        <button class="btn" style="width:100%" id="submit" disabled>Pick a time to continue</button>
      </form>
    </div>
  </div>

  <script>
  const slug=${JSON.stringify(shop.slug)}, service=${JSON.stringify(service.id)};
  const datesEl=document.getElementById('dates'), timesEl=document.getElementById('times');
  const startEl=document.getElementById('start'), submitEl=document.getElementById('submit'), staffEl=document.getElementById('staff');
  let selDate=null;
  const fmtDate=ds=>{const d=new Date(ds+'T12:00:00Z');return d.toLocaleDateString('en-AU',{weekday:'short',day:'numeric',month:'short'})};
  async function loadDates(){
    startEl.value='';submitEl.disabled=true;submitEl.textContent='Pick a time to continue';
    timesEl.innerHTML='<span class="muted">Choose a date first.</span>';
    datesEl.innerHTML='<span class="muted">Loading…</span>';
    const r=await fetch('/api/slots?shop='+slug+'&service='+service+'&staff='+staffEl.value);
    const {dates}=await r.json();
    if(!dates||!dates.length){datesEl.innerHTML='<span class="muted">No availability right now.</span>';return;}
    datesEl.innerHTML='';
    dates.slice(0,21).forEach(ds=>{const b=document.createElement('button');b.type='button';b.className='btn ghost sm';b.textContent=fmtDate(ds);
      b.onclick=()=>{selDate=ds;[...datesEl.children].forEach(x=>x.classList.add('ghost'));b.classList.remove('ghost');loadTimes(ds)};datesEl.appendChild(b)});
  }
  async function loadTimes(ds){
    startEl.value='';submitEl.disabled=true;submitEl.textContent='Pick a time to continue';
    timesEl.innerHTML='<span class="muted">Loading…</span>';
    const r=await fetch('/api/slots?shop='+slug+'&service='+service+'&staff='+staffEl.value+'&date='+ds);
    const {slots}=await r.json();
    if(!slots||!slots.length){timesEl.innerHTML='<span class="muted">Fully booked — try another day.</span>';return;}
    timesEl.innerHTML='';
    slots.forEach(s=>{const b=document.createElement('button');b.type='button';b.className='btn ghost sm';b.textContent=s.display;
      b.onclick=()=>{startEl.value=s.unix;[...timesEl.children].forEach(x=>x.classList.add('ghost'));b.classList.remove('ghost');
        submitEl.disabled=false;submitEl.textContent=${depositCents > 0 ? `'Confirm & pay deposit →'` : `'Confirm booking →'`}};timesEl.appendChild(b)});
  }
  staffEl.onchange=loadDates;loadDates();
  </script>
  `, { accent: shop.accent }))
})

app.post('/:slug/book', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop || !shop.is_published) return c.notFound()

  const form = await c.req.parseBody()
  const service = await db.prepare('SELECT * FROM services WHERE id = ? AND shop_id = ? AND is_active = 1')
    .bind(form.service, shop.id).first()
  if (!service) return c.text('Service unavailable', 400)

  const startUnix = parseInt(form.start)
  const name = (form.name || '').toString().trim()
  const email = (form.email || '').toString().trim().toLowerCase()
  if (!startUnix || !name || !email) return c.text('Missing details', 400)

  // Re-derive the date in the shop TZ and re-check the slot is genuinely free
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: shop.timezone }).format(new Date(startUnix * 1000))
  const slots = await slotsForDate(db, shop, service, form.staff?.toString() || 'any', dateStr)
  const slot = slots.find(s => s.unix === startUnix)
  if (!slot) return c.text('Sorry, that time was just taken. Please go back and pick another.', 409)

  // Assign a concrete therapist (first free one for "anyone available")
  const staffId = (form.staff && form.staff !== 'any' && slot.staffIds.includes(form.staff.toString()))
    ? form.staff.toString() : slot.staffIds[0]
  const staffRow = await db.prepare('SELECT name FROM staff WHERE id = ?').bind(staffId).first()

  const depositCents = Math.round(service.price_cents * shop.deposit_pct / 100)
  const bookingId = genId()
  const endUnix = startUnix + service.duration_minutes * 60
  const status = depositCents > 0 && c.env.STRIPE_SECRET_KEY ? 'pending_payment' : 'confirmed'

  await db.prepare(`INSERT INTO bookings
    (id, shop_id, service_id, staff_id, customer_name, customer_email, customer_phone,
     start_time, end_time, status, price_cents, deposit_cents, service_name, staff_name, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(bookingId, shop.id, service.id, staffId, name, email, (form.phone || '').toString(),
      startUnix, endUnix, status, service.price_cents, depositCents, service.name, staffRow?.name || '', (form.notes || '').toString()).run()

  // Payment required → Stripe Checkout
  if (status === 'pending_payment') {
    const base = c.env.BASE_URL || 'https://kneadly.theradicalparty.com'
    try {
      const session = await stripeClient(c.env.STRIPE_SECRET_KEY).createCheckoutSession({
        mode: 'payment',
        success_url: `${base}/${shop.slug}/booked/${bookingId}`,
        cancel_url: `${base}/${shop.slug}/book?service=${service.id}`,
        customer_email: email,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: shop.currency,
            unit_amount: depositCents,
            product_data: { name: `Deposit — ${service.name} at ${shop.name}`, description: `${formatBookingTime(startUnix, shop.timezone)} with ${staffRow?.name || 'our team'}` }
          }
        }],
        metadata: { booking_id: bookingId },
        expires_at: Math.floor(Date.now() / 1000) + 1800
      })
      await db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').bind(session.id, bookingId).run()
      return c.redirect(session.url)
    } catch (err) {
      console.error('Stripe error:', err.message)
      // Fall back to a confirmed (unpaid) booking so the customer isn't stuck
      await db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").bind(bookingId).run()
    }
  }

  return c.redirect(`/${shop.slug}/booked/${bookingId}`)
})

// ─── Confirmation ────────────────────────────────────────────────────────────
app.get('/:slug/booked/:id', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop) return c.notFound()
  const b = await db.prepare('SELECT * FROM bookings WHERE id = ? AND shop_id = ?').bind(c.req.param('id'), shop.id).first()
  if (!b) return c.notFound()

  // Returning from Stripe before the webhook lands? Confirm optimistically.
  const paid = b.status === 'confirmed' || b.status === 'completed'
  const pending = b.status === 'pending_payment'

  return c.html(layout(`Booking confirmed — ${shop.name}`, `
  ${siteNav(c.get('user'))}
  <div class="wrap narrow" style="padding:40px 20px;text-align:center">
    <div style="font-size:3rem">${pending ? '⏳' : '✅'}</div>
    <h2>${pending ? 'Almost there…' : 'You’re booked in!'}</h2>
    <p class="muted">${pending ? 'We’re confirming your deposit. This page will update shortly.' : `See you soon at ${esc(shop.name)}.`}</p>
    <div class="card" style="padding:22px;text-align:left;margin-top:18px">
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span class="muted">Service</span><strong>${esc(b.service_name)}</strong></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span class="muted">Therapist</span><strong>${esc(b.staff_name || 'Our team')}</strong></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span class="muted">When</span><strong>${formatBookingTime(b.start_time, shop.timezone)}</strong></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span class="muted">Price</span><strong>${money(b.price_cents, shop.currency)}</strong></div>
      ${b.deposit_cents > 0 ? `<div style="display:flex;justify-content:space-between;padding:8px 0"><span class="muted">Deposit paid</span><strong>${money(b.deposit_cents, shop.currency)}</strong></div>` : ''}
    </div>
    <p class="muted" style="font-size:.85rem;margin-top:16px">A confirmation was sent to ${esc(b.customer_email)}. Need to change it? Call ${esc(shop.phone || shop.name)}.</p>
    <a class="btn ghost" style="margin-top:8px" href="/${shop.slug}">Back to ${esc(shop.name)}</a>
  </div>
  ${pending ? '<script>setTimeout(()=>location.reload(),4000)</script>' : ''}
  `, { accent: shop.accent }))
})

export default app
