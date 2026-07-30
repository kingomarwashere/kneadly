# 💆 Alisa

Online booking for massage & bodywork shops — a lightweight Fresha alternative.
Each shop gets a public booking page they can drop straight into their **Google
Business Profile** so customers book them from Google Maps.

Live: https://alisa.bored.investments

## What it does

- **Shop owners** sign up → instantly get a booking page at `/<shop-slug>`
- Add **services** (duration + price), **therapists**, and per-therapist **weekly hours**
- **Customers** browse → pick service → pick therapist (or "anyone available") →
  pick a time → pay a deposit → booked
- **Deposits** (a configurable % of price) are taken via Stripe Checkout to stop no-shows;
  cancelling refunds automatically
- **Owner dashboard**: bookings list, mark complete / no-show / cancel+refund, edit
  services / staff / hours / settings
- **Google Maps ready**: every shop page emits `schema.org` `HealthAndBeautyBusiness`
  + `ReserveAction` JSON-LD, and the dashboard hands owners the exact URL to paste into
  their Google Business Profile "Appointment links" field

## Stack

Hono · Cloudflare Workers · D1 (SQLite) · Stripe · zero client framework (server-rendered HTML)

## Layout

```
src/
  index.js              router, session middleware, favicon/OG/robots/sitemap
  lib/
    auth.js             PBKDF2 password hashing, sessions
    stripe.js           tiny Stripe REST client (checkout, refunds, webhook verify)
    slots.js            timezone-aware slot generation
    booking.js          eligible-staff + availability logic (shared by API & booking)
    views.js            layout + design system (spa aesthetic)
  routes/
    auth.js             signup (creates owner + shop + default therapist) / login / logout
    public.js           landing page, shop pages, booking flow, confirmation
    dashboard.js        owner dashboard (overview, bookings, services, staff, settings)
    api.js              /api/slots — available dates & times
    webhooks.js         /webhooks/stripe — confirm booking on payment
schema.sql              D1 schema
```

## Develop

```bash
npm install
npm run db:migrate:local     # apply schema to local D1
npm run dev                  # wrangler dev
```

## Deploy

```bash
npm run db:migrate           # apply schema to remote D1
npm run deploy               # wrangler deploy
```

### Stripe (deposits)

Deposits are optional — with no Stripe key set, bookings confirm instantly (no payment).
To enable deposits, set the platform Stripe secrets:

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Then add a webhook endpoint in Stripe pointing at
`https://alisa.bored.investments/webhooks/stripe` for the
`checkout.session.completed` and `checkout.session.expired` events.

> Deposits currently settle to the platform Stripe account. Per-shop payouts via
> Stripe Connect is the natural next step.
