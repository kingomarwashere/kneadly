import { Hono } from 'hono'
import { layout, siteNav, money, esc } from '../lib/views.js'
import { t, localeFor } from '../lib/i18n.js'
import { getShopBySlug, eligibleStaff, slotsForDate, dayContext, assignPartyAt } from '../lib/booking.js'
import { formatBookingTime, formatDate } from '../lib/slots.js'
import { stripeClient } from '../lib/stripe.js'
import { genId } from '../lib/auth.js'
import { sendBookingEmails } from '../lib/email.js'
import { findOrCreateClient } from '../lib/clients.js'
import { translate, translateAll } from '../lib/translate.js'
import { loyaltyStatus } from '../lib/loyalty.js'

const app = new Hono()

// Demo shops featured on the landing page so visitors can test the real flow
const DEMO_SLUGS = ['serenity-massage-bodywork', 'thai-lotus-massage']

// ─── Marketing landing ───────────────────────────────────────────────────────
app.get('/', async (c) => {
  const user = c.get('user')
  const lang = c.get('lang')

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
      <span class="pill">${t(lang, 'demo_pill')}</span>
      <h2 style="margin-top:12px">${t(lang, 'demo_title')}</h2>
      <p class="muted" style="max-width:520px;margin:0 auto">${t(lang, 'demo_sub')}</p>
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
          <div class="muted" style="font-size:.85rem">${t(lang, 'count_services', { n: d.services })} · ${t(lang, 'count_therapists', { n: d.staff })}${d.from_price != null ? ` · ${t(lang, 'from_price', { price: money(d.from_price, d.currency) })}` : ''}</div>
          <div class="btn sm" style="margin-top:14px">${t(lang, 'demo_book_test')}</div>
        </div>
      </a>`).join('')}
    </div>
    <p class="muted" style="text-align:center;font-size:.82rem;margin-top:16px">${t(lang, 'demo_owner_1')} <strong>demo@alisa.co</strong> / <strong>massage2026</strong> ${t(lang, 'demo_owner_2')}</p>
  </div>` : ''

  return c.html(layout('Alisa — Online booking for massage shops', `
  ${siteNav(user, lang)}
  <div class="wrap" style="text-align:center;padding:60px 20px 40px">
    <span class="pill">${t(lang, 'hero_pill')}</span>
    <h1 style="margin-top:18px">${t(lang, 'hero_title_1')}<br>${t(lang, 'hero_title_2')}</h1>
    <p class="muted" style="font-size:1.15rem;max-width:600px;margin:0 auto 28px">
      ${t(lang, 'hero_sub')}
    </p>
    <div class="row" style="justify-content:center;flex:0">
      <a class="btn gold" href="/signup">${t(lang, 'hero_cta')}</a>
      <a class="btn ghost" href="#try">${t(lang, 'hero_demo')}</a>
    </div>
    <p class="muted" style="margin-top:14px;font-size:.85rem">${t(lang, 'hero_note')}</p>
  </div>

  ${demoSection}

  <div class="wrap grid g3" style="padding:20px 20px 10px" id="how">
    ${[
      ['🗓️', 'feat1_t', 'feat1_d'],
      ['💳', 'feat2_t', 'feat2_d'],
      ['📍', 'feat3_t', 'feat3_d'],
      ['🧖', 'feat4_t', 'feat4_d'],
      ['⏱️', 'feat5_t', 'feat5_d'],
      ['🔗', 'feat6_t', 'feat6_d'],
    ].map(([e, tk, dk]) => `<div class="card" style="padding:24px"><div style="font-size:2rem">${e}</div>
      <h3 style="margin:.5em 0 .2em;font-size:1.15rem">${t(lang, tk)}</h3><p class="muted" style="margin:0">${t(lang, dk)}</p></div>`).join('')}
  </div>

  <div class="wrap" style="padding:50px 20px">
    <div class="card" style="padding:34px;text-align:center;background:linear-gradient(135deg,#0f766e,#0b5750);color:#fff;border:none">
      <h2 style="color:#fff">${t(lang, 'cta_title')}</h2>
      <p style="color:#a7d3ce;max-width:460px;margin:0 auto 22px">${t(lang, 'cta_sub')}</p>
      <a class="btn gold" href="/signup">${t(lang, 'cta_btn')}</a>
    </div>
  </div>
  `, {
    lang,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'SoftwareApplication',
      name: 'Alisa', applicationCategory: 'BusinessApplication',
      description: 'Online booking software for massage and bodywork businesses.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'AUD' }
    }
  }))
})

// ─── Shop public page ────────────────────────────────────────────────────────
app.get('/:slug', async (c) => {
  const db = c.env.DB
  const lang = c.get('lang')
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop || !shop.is_published) return c.notFound()

  const services = (await db.prepare(
    'SELECT * FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  const staff = (await db.prepare(
    'SELECT * FROM staff WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []

  // Auto-translate owner content into the customer's language (cached).
  await Promise.all([
    ...services.map(async s => { s.name = await translate(c.env, s.name, lang); s.description = await translate(c.env, s.description, lang) }),
    ...staff.map(async st => { st.title = await translate(c.env, st.title, lang) }),
    (async () => { shop.tagline = await translate(c.env, shop.tagline, lang); shop.about = await translate(c.env, shop.about, lang) })(),
  ])

  const base = c.env.BASE_URL || 'https://alisa.bored.investments'
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
        <div class="muted" style="font-size:.85rem;margin-top:4px">⏱ ${s.duration_minutes} ${t(lang, 'min')} · ${money(s.price_cents, shop.currency)}</div>
      </div>
      <a class="btn sm" href="/${shop.slug}/book?service=${s.id}">${t(lang, 'book')}</a>
    </div>`

  return c.html(layout(`${shop.name} — ${t(lang, 'book_online')}`, `
  ${siteNav(c.get('user'), lang)}
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
      <h2>${t(lang, 'services')}</h2>
      ${services.length ? services.map(serviceCard).join('') : `<p class="muted">${t(lang, 'no_services')}</p>`}
    </div>
    <div>
      ${shop.about ? `<h2>${t(lang, 'about')}</h2><div class="card" style="padding:20px"><p class="muted" style="margin:0;white-space:pre-wrap">${esc(shop.about)}</p></div>` : ''}
      ${staff.length ? `<h2 style="margin-top:22px">${t(lang, 'our_therapists')}</h2>
        <div class="card" style="padding:8px 20px">
        ${staff.map(st => `<div style="padding:12px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center">
          <div style="font-size:1.6rem">${esc(st.emoji)}</div>
          <div><div style="font-weight:600">${esc(st.name)}</div><div class="muted" style="font-size:.85rem">${esc(st.title || '')}</div></div>
        </div>`).join('')}
        </div>` : ''}
    </div>
  </div>
  `, { accent: shop.accent, lang, description: shop.tagline || `Book ${shop.name} online.`, jsonld }))
})

// ─── Booking flow ────────────────────────────────────────────────────────────
app.get('/:slug/book', async (c) => {
  const db = c.env.DB
  const lang = c.get('lang')
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop || !shop.is_published) return c.notFound()

  const serviceId = c.req.query('service')
  const service = serviceId
    ? await db.prepare('SELECT * FROM services WHERE id = ? AND shop_id = ? AND is_active = 1').bind(serviceId, shop.id).first()
    : null

  // No service chosen → show the picker
  if (!service) {
    const services = (await db.prepare('SELECT * FROM services WHERE shop_id = ? AND is_active = 1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
    await Promise.all(services.map(async s => { s.name = await translate(c.env, s.name, lang) }))
    return c.html(layout(`${t(lang, 'book')} — ${shop.name}`, `${siteNav(c.get('user'), lang)}<div class="wrap narrow" style="padding:30px 20px">
      <a href="/${shop.slug}" class="muted">← ${esc(shop.name)}</a><h2 style="margin-top:10px">${t(lang, 'choose_service')}</h2>
      ${services.map(s => `<a class="card svc" style="padding:16px 20px;display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;text-decoration:none;color:inherit" href="/${shop.slug}/book?service=${s.id}">
        <div><div style="font-weight:600">${esc(s.name)}</div><div class="muted" style="font-size:.85rem">${s.duration_minutes} ${t(lang, 'min')} · ${money(s.price_cents, shop.currency)}</div></div><span class="btn sm">${t(lang, 'select')}</span></a>`).join('')}
      </div>`, { accent: shop.accent, lang }))
  }

  const staff = await eligibleStaff(db, shop.id, service.id)
  const depositCents = Math.round(service.price_cents * shop.deposit_pct / 100)
  // Translate the chosen service's name + description for display.
  ;[service.name, service.description] = await translateAll(c.env, [service.name, service.description], lang)
  // All services (translated) for the couple/group guest pickers.
  const allServices = (await db.prepare('SELECT id,name,duration_minutes FROM services WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []
  await Promise.all(allServices.map(async s => { s.name = await translate(c.env, s.name, lang) }))
  // Every active therapist — for the per-guest therapist picker in group bookings.
  const groupStaff = (await db.prepare('SELECT id,name,emoji FROM staff WHERE shop_id=? AND is_active=1 ORDER BY sort_order, created_at').bind(shop.id).all()).results || []

  const T = {
    loading: t(lang, 'loading'),
    choose_date_first: t(lang, 'choose_date_first'),
    no_availability: t(lang, 'no_availability'),
    fully_booked: t(lang, 'fully_booked'),
    pick_time_btn: t(lang, 'pick_time_btn'),
    confirm: depositCents > 0 ? t(lang, 'confirm_pay') : t(lang, 'confirm_book'),
  }

  return c.html(layout(`${t(lang, 'book')} ${service.name} — ${shop.name}`, `
  ${siteNav(c.get('user'), lang)}
  <div class="wrap narrow" style="padding:26px 20px">
    <a href="/${shop.slug}" class="muted">← ${esc(shop.name)}</a>
    <div class="card" style="padding:26px;margin-top:12px">
      <div class="pill">${service.duration_minutes} ${t(lang, 'min')} · ${money(service.price_cents, shop.currency)}</div>
      <h2 style="margin:.4em 0 0">${esc(service.name)}</h2>
      ${service.description ? `<p class="muted" style="margin:.3em 0 0">${esc(service.description)}</p>` : ''}

      <form method="post" action="/${shop.slug}/book" id="bk">
        <input type="hidden" name="service" value="${service.id}">
        <input type="hidden" name="start" id="start">

        <style>
          .segwrap{display:flex;gap:10px;margin:.3em 0 .2em}
          .seg{flex:1;padding:15px 12px;border:1.5px solid var(--line);border-radius:14px;background:#fff;color:var(--ink);font-weight:600;font-size:.98rem;cursor:pointer;transition:.12s;line-height:1.2}
          .seg small{display:block;font-weight:400;font-size:.76rem;color:var(--muted);margin-top:2px}
          .seg.on{border-color:var(--accent);background:#eef4f3;color:var(--accent-ink);box-shadow:0 0 0 3px rgba(15,118,110,.10)}
          .seg.on small{color:var(--accent-ink)}
          .pcard{border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}
          .pcard .field:last-child{margin-bottom:0}
        </style>
        <h3 style="margin:1.2em 0 .4em;font-size:1.05rem">${t(lang, 'bk_type')}</h3>
        <div class="segwrap">
          <button type="button" class="seg on" id="segSingle" data-type="single">🧍 ${t(lang, 'just_me')}</button>
          <button type="button" class="seg" id="segGroup" data-type="group">👥 ${t(lang, 'group_couple')}</button>
        </div>

        <h3 id="peopleHead" style="margin:1.4em 0 .4em;font-size:1.05rem">${t(lang, 'step1')}</h3>
        <p id="grpnote" class="muted" style="display:none;font-size:.83rem;margin:-.15em 0 .7em">${t(lang, 'same_time_note')}</p>

        <div id="p1card">
          <div id="p1head" style="display:none;margin-bottom:8px"><strong>👤 ${t(lang, 'you')}</strong></div>
          <div id="p1svc" class="muted" style="display:none;font-size:.85rem;margin-bottom:10px">${esc(service.name)} · ${service.duration_minutes} ${t(lang, 'min')} · ${money(service.price_cents, shop.currency)}</div>
          <label id="p1lbl" style="display:none">${t(lang, 'c_therapist')}</label>
          <select name="staff" id="staff">
            <option value="any">${t(lang, 'anyone')}</option>
            ${staff.map(s => `<option value="${s.id}">${esc(s.emoji)} ${esc(s.name)}</option>`).join('')}
          </select>
        </div>

        <div id="groupwrap" style="display:none">
          ${[2, 3, 4].map(n => `<div class="guestx pcard" data-n="${n}" style="display:none">
            <div class="inline" style="justify-content:space-between;align-items:center;margin-bottom:8px"><strong>👤 ${t(lang, 'guest')} ${n - 1}</strong><button type="button" class="btn ghost sm rmperson">${t(lang, 'remove_word')}</button></div>
            <div class="field"><label>${t(lang, 'full_name')} <span class="muted">(${t(lang, 'optional')})</span></label><input name="guest_name_${n}"></div>
            <div class="field"><label>${t(lang, 'services')}</label><select name="guest_service_${n}" class="gsvc"><option value="">—</option>${allServices.map(s => `<option value="${s.id}">${esc(s.name)} · ${s.duration_minutes} ${t(lang, 'min')}</option>`).join('')}</select></div>
            <div class="field" style="margin-bottom:0"><label>${t(lang, 'c_therapist')}</label><select name="guest_staff_${n}" class="gstf"><option value="any">✨ ${t(lang, 'anyone')}</option>${groupStaff.map(s => `<option value="${s.id}">${esc(s.emoji)} ${esc(s.name)}</option>`).join('')}</select></div>
          </div>`).join('')}
          <button type="button" class="btn ghost sm" id="addperson" style="margin-bottom:6px">➕ ${t(lang, 'add_person')}</button>
        </div>

        <h3 style="margin:1.4em 0 .4em;font-size:1.05rem">${t(lang, 'step2')}</h3>
        <div id="dates" class="row" style="gap:8px"><span class="muted">${t(lang, 'loading')}</span></div>

        <h3 style="margin:1.4em 0 .4em;font-size:1.05rem">${t(lang, 'step3')}</h3>
        <div id="times" class="row" style="gap:8px"><span class="muted">${t(lang, 'choose_date_first')}</span></div>

        <h3 style="margin:1.4em 0 .4em;font-size:1.05rem">${t(lang, 'step4')}</h3>
        <div class="field"><label>${t(lang, 'full_name')}</label><input name="name" required></div>
        <div class="field"><label>${t(lang, 'email')}</label><input type="email" name="email" required></div>
        <div class="field"><label>${t(lang, 'mobile')}</label><input name="phone" placeholder="${t(lang, 'optional')}"></div>
        <div class="field"><label>${t(lang, 'notes_label')}</label><textarea name="notes" rows="2" placeholder="${t(lang, 'notes_ph')}"></textarea></div>

        <div id="depositcard" class="card" style="padding:14px 16px;background:#f6f2ec;border-style:dashed;margin-bottom:16px">
          ${depositCents > 0
            ? t(lang, 'deposit_line', { deposit: money(depositCents, shop.currency), rest: money(service.price_cents - depositCents, shop.currency), hours: shop.cancellation_hours })
            : t(lang, 'no_deposit_line')}
        </div>

        <button class="btn" style="width:100%" id="submit" disabled>${t(lang, 'pick_time_btn')}</button>
      </form>
    </div>
  </div>

  <script>
  const slug=${JSON.stringify(shop.slug)}, service=${JSON.stringify(service.id)};
  const T=${JSON.stringify(T)}, LOCALE=${JSON.stringify(localeFor(lang))};
  const datesEl=document.getElementById('dates'), timesEl=document.getElementById('times');
  const startEl=document.getElementById('start'), submitEl=document.getElementById('submit'), staffEl=document.getElementById('staff');
  let selDate=null;
  const fmtDate=ds=>{const d=new Date(ds+'T12:00:00Z');return d.toLocaleDateString(LOCALE,{weekday:'short',day:'numeric',month:'short'})};
  async function loadDates(){
    startEl.value='';submitEl.disabled=true;submitEl.textContent=T.pick_time_btn;
    timesEl.innerHTML='<span class="muted">'+T.choose_date_first+'</span>';
    datesEl.innerHTML='<span class="muted">'+T.loading+'</span>';
    const r=await fetch('/api/slots?shop='+slug+'&service='+service+'&staff='+staffEl.value);
    const {dates}=await r.json();
    if(!dates||!dates.length){datesEl.innerHTML='<span class="muted">'+T.no_availability+'</span>';return;}
    datesEl.innerHTML='';
    dates.slice(0,21).forEach(ds=>{const b=document.createElement('button');b.type='button';b.className='btn ghost sm';b.textContent=fmtDate(ds);
      b.onclick=()=>{selDate=ds;[...datesEl.children].forEach(x=>x.classList.add('ghost'));b.classList.remove('ghost');loadTimes(ds)};datesEl.appendChild(b)});
  }
  // Build the whole party (person 1 + any added guests) for group-aware times.
  function party(){
    var p=[{serviceId:service,staffPref:staffEl.value}];
    shownGuests().forEach(function(g){var sv=g.querySelector('.gsvc'),st=g.querySelector('.gstf');
      if(sv&&sv.value)p.push({serviceId:sv.value,staffPref:st?st.value:'any'});});
    return p;
  }
  async function loadTimes(ds){
    startEl.value='';submitEl.disabled=true;submitEl.textContent=T.pick_time_btn;
    timesEl.innerHTML='<span class="muted">'+T.loading+'</span>';
    var url='/api/group-slots?shop='+slug+'&date='+ds+'&party='+encodeURIComponent(JSON.stringify(party()));
    const r=await fetch(url);
    const {slots}=await r.json();
    if(!slots||!slots.length){timesEl.innerHTML='<span class="muted">'+T.fully_booked+'</span>';return;}
    timesEl.innerHTML='';
    slots.forEach(s=>{const b=document.createElement('button');b.type='button';b.className='btn ghost sm';b.textContent=s.display;
      b.onclick=()=>{startEl.value=s.unix;[...timesEl.children].forEach(x=>x.classList.add('ghost'));b.classList.remove('ghost');
        submitEl.disabled=false;submitEl.textContent=T.confirm};timesEl.appendChild(b)});
  }
  function reloadTimes(){startEl.value='';submitEl.disabled=true;submitEl.textContent=T.pick_time_btn;if(selDate)loadTimes(selDate);}
  staffEl.onchange=loadDates;loadDates();
  // Couple / group guests: reveal one block at a time with "add another person".
  // Changing the party re-checks which times can fit EVERYONE at once.
  var addBtn=document.getElementById('addperson'),depc=document.getElementById('depositcard');
  var guestBlocks=[].slice.call(document.querySelectorAll('.guestx'));
  function shownGuests(){return guestBlocks.filter(function(g){return g.style.display!=='none';});}
  function syncGuests(){var hidden=guestBlocks.filter(function(g){return g.style.display==='none';});
    if(addBtn)addBtn.style.display=hidden.length?'':'none';
    if(depc)depc.style.display=shownGuests().length?'none':'';}
  if(addBtn)addBtn.addEventListener('click',function(){var hidden=guestBlocks.filter(function(g){return g.style.display==='none';});if(hidden.length)hidden[0].style.display='';syncGuests();reloadTimes();});
  document.querySelectorAll('.rmperson').forEach(function(b){b.addEventListener('click',function(){var g=b.closest('.guestx');g.style.display='none';
    g.querySelectorAll('input').forEach(function(i){i.value='';});g.querySelectorAll('select').forEach(function(s){s.selectedIndex=0;});syncGuests();reloadTimes();});});
  document.querySelectorAll('.gsvc,.gstf').forEach(function(s){s.addEventListener('change',reloadTimes);});
  // Single vs Group — the first choice. Group reveals the guest section; single
  // hides & clears it so solo bookings stay short (therapist → date → time → you).
  var groupWrap=document.getElementById('groupwrap'),segSingle=document.getElementById('segSingle'),segGroup=document.getElementById('segGroup');
  var peopleHead=document.getElementById('peopleHead'),grpnote=document.getElementById('grpnote'),p1card=document.getElementById('p1card'),p1head=document.getElementById('p1head'),p1svc=document.getElementById('p1svc'),p1lbl=document.getElementById('p1lbl');
  var GRP_HEAD=${JSON.stringify(t(lang, 'grp_head'))}, SINGLE_HEAD=${JSON.stringify(t(lang, 'step1'))};
  function setType(type){var group=type==='group';
    segGroup.classList.toggle('on',group);segSingle.classList.toggle('on',!group);
    groupWrap.style.display=group?'':'none';
    // In group mode, present person 1 as a "You" card so the group reads You → Guest 1 → …
    peopleHead.textContent=group?GRP_HEAD:SINGLE_HEAD;
    grpnote.style.display=group?'':'none';
    p1card.classList.toggle('pcard',group);
    p1head.style.display=group?'':'none';p1svc.style.display=group?'':'none';p1lbl.style.display=group?'':'none';
    if(group){if(!shownGuests().length){var h=guestBlocks.filter(function(g){return g.style.display==='none';});if(h.length)h[0].style.display='';}}
    else{guestBlocks.forEach(function(g){g.style.display='none';g.querySelectorAll('input').forEach(function(i){i.value='';});g.querySelectorAll('select').forEach(function(s){s.selectedIndex=0;});});}
    syncGuests();reloadTimes();}
  segSingle.addEventListener('click',function(){setType('single');});
  segGroup.addEventListener('click',function(){setType('group');});
  syncGuests();
  </script>
  `, { accent: shop.accent, lang }))
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

  // Re-derive the date in the shop TZ.
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: shop.timezone }).format(new Date(startUnix * 1000))

  // Build the party: primary first, then any group guests with a chosen service.
  const primaryPref = (form.staff || 'any').toString()
  const guestSpecs = [2, 3, 4].map(n => ({ sid: (form[`guest_service_${n}`] || '').toString(), name: (form[`guest_name_${n}`] || '').toString().trim() || `Guest ${n}`, staff: (form[`guest_staff_${n}`] || 'any').toString() })).filter(g => g.sid)
  const isGroup = guestSpecs.length > 0
  const groupId = isGroup ? genId() : null

  const partyPeople = [{ service, staffPref: primaryPref === 'any' ? 'any' : primaryPref }]
  for (const g of guestSpecs) {
    const gsvc = await db.prepare('SELECT * FROM services WHERE id=? AND shop_id=? AND is_active=1').bind(g.sid, shop.id).first()
    if (!gsvc) return c.text('One of the selected services is unavailable. Please go back.', 400)
    g.svc = gsvc
    partyPeople.push({ service: gsvc, staffPref: (g.staff && g.staff !== 'any') ? g.staff : 'any' })
  }

  // Seat the WHOLE party at the chosen time with DISTINCT free therapists —
  // the same matching the time picker used, so what was offered is bookable.
  const ctx = await dayContext(db, shop, dateStr)
  const assigned = assignPartyAt(ctx, partyPeople, startUnix)
  if (!assigned) return c.text('Sorry, that time was just taken (or your group no longer fits). Please go back and pick another.', 409)
  const primaryStaffName = ctx.staffById[assigned[0]]?.name || ''

  // Save/refresh the primary person as a client.
  const clientId = await findOrCreateClient(db, shop.id, { name, email, phone: (form.phone || '').toString() })

  // Build the booking list (primary first). A specific therapist = a "request".
  const items = [{ service, staffId: assigned[0], staffName: primaryStaffName, name, email, phone: (form.phone || '').toString(), notes: (form.notes || '').toString(), clientId, requested: primaryPref !== 'any' ? 1 : 0 }]
  for (let i = 0; i < guestSpecs.length; i++) {
    const g = guestSpecs[i], stId = assigned[i + 1]
    const gClient = await findOrCreateClient(db, shop.id, { name: g.name })
    items.push({ service: g.svc, staffId: stId, staffName: ctx.staffById[stId]?.name || '', name: g.name, email: '', phone: '', notes: '', clientId: gClient, requested: (g.staff && g.staff !== 'any') ? 1 : 0 })
  }

  // Deposit is charged ONCE for the whole booking/group (sum of each person's).
  const dep = (svc) => Math.round(svc.price_cents * shop.deposit_pct / 100)
  const totalDeposit = items.reduce((s, it) => s + dep(it.service), 0)
  const useStripe = shop.deposit_pct > 0 && !!c.env.STRIPE_SECRET_KEY && totalDeposit > 0
  const status = useStripe ? 'pending_payment' : 'confirmed'

  // Insert every booking (own price + own deposit share + shared group_id).
  const ids = []
  for (const it of items) {
    const id = genId(); ids.push(id)
    await db.prepare(`INSERT INTO bookings
      (id, shop_id, service_id, staff_id, customer_name, customer_email, customer_phone,
       start_time, end_time, status, price_cents, deposit_cents, service_name, staff_name, notes, lang, client_id, requested_staff, group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, shop.id, it.service.id, it.staffId, it.name, it.email, it.phone,
        startUnix, startUnix + it.service.duration_minutes * 60, status, it.service.price_cents, dep(it.service), it.service.name, it.staffName, it.notes, c.get('lang') || 'en', it.clientId, it.requested, groupId).run()
  }
  const bookingId = ids[0]

  // One Stripe deposit for the whole booking/group; the webhook confirms all of it.
  if (status === 'pending_payment') {
    const base = c.env.BASE_URL || 'https://alisa.bored.investments'
    const label = items.length > 1 ? `Deposit — ${items.length} appointments at ${shop.name}` : `Deposit — ${service.name} at ${shop.name}`
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
            unit_amount: totalDeposit,
            product_data: { name: label, description: `${formatBookingTime(startUnix, shop.timezone)}${items.length > 1 ? ` · ${items.length} people` : ` with ${primaryStaffName || 'our team'}`}` }
          }
        }],
        metadata: { booking_id: bookingId, group_id: groupId || '' },
        expires_at: Math.floor(Date.now() / 1000) + 1800
      })
      await db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').bind(session.id, bookingId).run()
      return c.redirect(session.url)
    } catch (err) {
      console.error('Stripe error:', err.message)
      // Fall back to confirmed (unpaid) for the whole group so nobody is stuck.
      if (groupId) await db.prepare("UPDATE bookings SET status='confirmed' WHERE group_id=?").bind(groupId).run()
      else await db.prepare("UPDATE bookings SET status='confirmed' WHERE id=?").bind(bookingId).run()
    }
  }

  // Email the customer + owner for confirmed bookings (Stripe ones email from the
  // webhook). Never blocks/fails.
  const emailP = sendBookingEmails(c.env, bookingId)
  if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(emailP); else await emailP

  return c.redirect(`/${shop.slug}/booked/${bookingId}`)
})

// ─── Confirmation ────────────────────────────────────────────────────────────
app.get('/:slug/booked/:id', async (c) => {
  const db = c.env.DB
  const lang = c.get('lang')
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop) return c.notFound()
  const b = await db.prepare('SELECT * FROM bookings WHERE id = ? AND shop_id = ?').bind(c.req.param('id'), shop.id).first()
  if (!b) return c.notFound()

  b.service_name = await translate(c.env, b.service_name, lang)

  // Other guests in the same group (couples/group booking).
  let groupMembers = [], groupTotalPrice = 0, groupTotalDeposit = 0
  if (b.group_id) {
    groupMembers = (await db.prepare('SELECT customer_name, service_name, staff_name, price_cents, deposit_cents FROM bookings WHERE group_id=? AND id<>? ORDER BY customer_name').bind(b.group_id, b.id).all()).results || []
    await Promise.all(groupMembers.map(async m => { m.service_name = await translate(c.env, m.service_name, lang) }))
    groupTotalPrice = b.price_cents + groupMembers.reduce((s, m) => s + (m.price_cents || 0), 0)
    groupTotalDeposit = b.deposit_cents + groupMembers.reduce((s, m) => s + (m.deposit_cents || 0), 0)
  }
  // This customer's loyalty progress.
  let loy = { enabled: false }
  if (shop.loyalty_enabled && b.client_id) {
    const client = await db.prepare('SELECT * FROM clients WHERE id=?').bind(b.client_id).first()
    if (client) loy = await loyaltyStatus(db, shop, client)
  }

  // Returning from Stripe before the webhook lands? Confirm optimistically.
  const paid = b.status === 'confirmed' || b.status === 'completed'
  const pending = b.status === 'pending_payment'

  return c.html(layout(`${t(lang, 'booking_confirmed')} — ${shop.name}`, `
  ${siteNav(c.get('user'), lang)}
  <div class="wrap narrow" style="padding:40px 20px;text-align:center">
    <div style="font-size:3rem">${pending ? '⏳' : '✅'}</div>
    <h2>${pending ? t(lang, 'almost_there') : t(lang, 'booked_in')}</h2>
    <p class="muted">${pending ? t(lang, 'pending_sub') : t(lang, 'done_sub', { shop: esc(shop.name) })}</p>
    <div class="card" style="padding:22px;text-align:left;margin-top:18px">
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span class="muted">${t(lang, 'c_service')}</span><strong>${esc(b.service_name)}</strong></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span class="muted">${t(lang, 'c_therapist')}</span><strong>${esc(b.staff_name || t(lang, 'our_team'))}</strong></div>
      <div style="display:flex;justify-content:space-between;padding:8px 0${b.group_id ? '' : ';border-bottom:1px solid var(--line)'}"><span class="muted">${t(lang, 'c_when')}</span><strong>${formatBookingTime(b.start_time, shop.timezone)}</strong></div>
      ${b.group_id ? '' : `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)"><span class="muted">${t(lang, 'c_price')}</span><strong>${money(b.price_cents, shop.currency)}</strong></div>`}
      ${(b.deposit_cents > 0 && !b.group_id) ? `<div style="display:flex;justify-content:space-between;padding:8px 0"><span class="muted">${t(lang, 'c_deposit_paid')}</span><strong>${money(b.deposit_cents, shop.currency)}</strong></div>` : ''}
    </div>
    ${groupMembers.length ? `<div class="card" style="padding:16px 20px;text-align:left;margin-top:14px">
      <div style="font-weight:600;margin-bottom:4px">👥 ${t(lang, 'group_booked', { n: groupMembers.length + 1 })}</div>
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line)"><span>${esc(b.customer_name)}</span><span class="muted">${esc(b.service_name)} · ${esc(b.staff_name || '')} · ${money(b.price_cents, shop.currency)}</span></div>
      ${groupMembers.map(m => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line)"><span>${esc(m.customer_name)}</span><span class="muted">${esc(m.service_name)} · ${esc(m.staff_name || '')} · ${money(m.price_cents, shop.currency)}</span></div>`).join('')}
      <div style="display:flex;justify-content:space-between;padding:8px 0 0;border-top:2px solid var(--line);margin-top:4px;font-weight:700"><span>${t(lang, 'group_total', { n: groupMembers.length + 1 })}</span><span>${money(groupTotalPrice, shop.currency)}</span></div>
      ${groupTotalDeposit > 0 ? `<div style="display:flex;justify-content:space-between;padding:6px 0 0"><span class="muted">${t(lang, 'c_deposit_paid')}</span><strong>${money(groupTotalDeposit, shop.currency)}</strong></div>` : ''}
    </div>` : ''}
    ${loy.enabled ? `<div class="card" style="padding:16px 20px;text-align:left;margin-top:14px;background:#fdf7e8;border-color:#f0d9a8">
      <div style="font-weight:600">${t(lang, 'loyalty_head')}</div>
      <div class="muted" style="margin:4px 0">${t(lang, 'loyalty_visits', { n: loy.completed })}</div>
      ${loy.available.length ? `<div style="color:#8a6414;font-weight:600">${t(lang, 'loyalty_ready', { n: loy.available.length })}</div>` : (loy.next ? `<div class="muted">${t(lang, 'loyalty_next', { n: loy.next.visits - loy.completed, reward: loy.next.label })}</div>` : '')}
    </div>` : ''}
    <p class="muted" style="font-size:.85rem;margin-top:16px">${t(lang, 'conf_email_note', { email: esc(b.customer_email), contact: esc(shop.phone || shop.name) })}</p>
    <a class="btn ghost" style="margin-top:8px" href="/${shop.slug}">${t(lang, 'back_to', { shop: esc(shop.name) })}</a>
  </div>
  ${pending ? '<script>setTimeout(()=>location.reload(),4000)</script>' : ''}
  `, { accent: shop.accent, lang }))
})

// ─── Reviews ─────────────────────────────────────────────────────────────────
function reviewThanks(shop, review, lang, justSubmitted) {
  const showGoogle = review.rating >= 4 && shop.google_review_url
  return layout(`${t(lang, 'review_thanks_head')} — ${shop.name}`, `
    ${siteNav(null, lang)}
    <div class="wrap narrow" style="padding:50px 20px;text-align:center">
      <div style="font-size:3rem">🙏</div>
      <h2>${t(lang, 'review_thanks_head')}</h2>
      <p class="muted">${justSubmitted ? t(lang, 'review_thanks_sub') : t(lang, 'review_already')}</p>
      <div style="font-size:1.6rem;color:#e6a817;margin:6px 0;letter-spacing:2px">${'★'.repeat(review.rating)}<span style="color:#d9d2c7">${'★'.repeat(5 - review.rating)}</span></div>
      ${showGoogle ? `<div class="card" style="padding:22px;margin-top:16px">
        <p style="margin:0 0 12px">${t(lang, 'review_google_cta')}</p>
        <a class="btn" href="${esc(shop.google_review_url)}" target="_blank" rel="noopener">${t(lang, 'review_google_btn')}</a>
      </div>` : ''}
      <div><a class="btn ghost" style="margin-top:14px" href="/${shop.slug}">${esc(shop.name)}</a></div>
    </div>`, { lang, accent: shop.accent })
}

function reviewFormPage(shop, lang, action, withName) {
  return layout(`${t(lang, 'review_title')} — ${shop.name}`, `
    ${siteNav(null, lang)}
    <div class="wrap narrow" style="padding:40px 20px;text-align:center">
      <div style="font-size:2.4rem">${esc(shop.emoji)}</div>
      <h2>${t(lang, 'review_title')}</h2>
      <p class="muted">${t(lang, 'review_sub', { shop: esc(shop.name) })}</p>
      <form method="post" action="${action}" class="card" style="padding:26px;text-align:left;margin-top:14px">
        ${withName ? `<div class="field"><label>${t(lang, 'full_name')} (${t(lang, 'optional')})</label><input name="name"></div>` : ''}
        <div class="field"><label>${t(lang, 'review_rating')}</label>
          <div id="stars" style="font-size:2.4rem;cursor:pointer;color:#d9d2c7;user-select:none;letter-spacing:4px">
            ${[1, 2, 3, 4, 5].map(v => `<span data-v="${v}">★</span>`).join('')}
          </div>
          <input type="hidden" name="rating" id="rating" value="">
        </div>
        <div class="field"><label>${t(lang, 'review_comment')}</label><textarea name="body" rows="4"></textarea></div>
        <button class="btn" style="width:100%">${t(lang, 'review_submit')}</button>
      </form>
    </div>
    <script>
    (function(){var stars=[].slice.call(document.querySelectorAll('#stars span')),inp=document.getElementById('rating');
      function paint(n){stars.forEach(function(s){s.style.color=(+s.dataset.v<=n)?'#e6a817':'#d9d2c7';});}
      stars.forEach(function(s){s.addEventListener('click',function(){inp.value=s.dataset.v;paint(+s.dataset.v);});
        s.addEventListener('mouseenter',function(){paint(+s.dataset.v);});});
      document.getElementById('stars').addEventListener('mouseleave',function(){paint(+inp.value||0);});
      document.querySelector('form').addEventListener('submit',function(e){if(!inp.value){e.preventDefault();alert(${JSON.stringify(t(lang, 'review_pick'))});}});
    })();
    </script>`, { lang, accent: shop.accent })
}

// Booking-specific review (from the post-visit email link).
app.get('/:slug/review/:id', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop) return c.notFound()
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(c.req.param('id'), shop.id).first()
  if (!b) return c.notFound()
  const lang = b.lang || c.get('lang')
  const existing = await db.prepare('SELECT * FROM reviews WHERE booking_id=?').bind(b.id).first()
  if (existing) return c.html(reviewThanks(shop, existing, lang, false))
  return c.html(reviewFormPage(shop, lang, `/${shop.slug}/review/${b.id}`, false))
})

// Generic shop review (from the QR / review link). Kept internally; 4–5★ are
// then offered the Google review handoff.
app.get('/:slug/review', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop) return c.notFound()
  const lang = c.get('lang')
  return c.html(reviewFormPage(shop, lang, `/${shop.slug}/review`, true))
})

app.post('/:slug/review', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop) return c.notFound()
  const lang = c.get('lang')
  const f = await c.req.parseBody()
  const rating = Math.max(1, Math.min(5, parseInt(f.rating) || 0))
  if (!f.rating) return c.redirect(`/${shop.slug}/review`)
  await db.prepare('INSERT INTO reviews (id, shop_id, booking_id, client_id, staff_name, customer_name, rating, body) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)')
    .bind(genId(), shop.id, (f.name || '').toString().trim() || 'Guest', rating, (f.body || '').toString().trim() || null).run()
  return c.html(reviewThanks(shop, { rating }, lang, true))
})

app.post('/:slug/review/:id', async (c) => {
  const db = c.env.DB
  const shop = await getShopBySlug(db, c.req.param('slug'))
  if (!shop) return c.notFound()
  const b = await db.prepare('SELECT * FROM bookings WHERE id=? AND shop_id=?').bind(c.req.param('id'), shop.id).first()
  if (!b) return c.notFound()
  const lang = b.lang || c.get('lang')
  const existing = await db.prepare('SELECT * FROM reviews WHERE booking_id=?').bind(b.id).first()
  if (existing) return c.html(reviewThanks(shop, existing, lang, false))

  const f = await c.req.parseBody()
  const rating = Math.max(1, Math.min(5, parseInt(f.rating) || 0))
  if (!f.rating) return c.redirect(`/${shop.slug}/review/${b.id}`)
  await db.prepare('INSERT INTO reviews (id, shop_id, booking_id, client_id, staff_name, customer_name, rating, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(genId(), shop.id, b.id, b.client_id || null, b.staff_name || null, b.customer_name || null, rating, (f.body || '').toString().trim() || null).run()
  return c.html(reviewThanks(shop, { rating }, lang, true))
})

export default app
