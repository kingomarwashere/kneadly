-- Alisa — booking platform for massage shops
-- Multi-tenant: one owner account owns one shop (schema allows more later).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- The massage business / shop
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  tagline TEXT,
  about TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  suburb TEXT,
  state TEXT,
  postcode TEXT,
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  emoji TEXT NOT NULL DEFAULT '💆',
  accent TEXT NOT NULL DEFAULT '#0f766e',
  currency TEXT NOT NULL DEFAULT 'aud',
  deposit_pct INTEGER NOT NULL DEFAULT 20,   -- % of service price taken as deposit (used when charge_mode='deposit')
  charge_mode TEXT NOT NULL DEFAULT 'deposit',   -- none | deposit | full : what customers pay when booking online
  cancellation_hours INTEGER NOT NULL DEFAULT 24,
  slot_interval_minutes INTEGER NOT NULL DEFAULT 15,  -- spacing between bookable start times
  hours_json TEXT,               -- opening hours: {"0":["09:00","18:00"],...} keyed by weekday (0=Sun); null/missing day = closed
  stripe_account_id TEXT,        -- Stripe Connect (Express) account id — deposits are charged here; null = no online payments (demo/test mode)
  stripe_charges_enabled INTEGER NOT NULL DEFAULT 0,   -- account can accept charges (from account.updated / retrieve)
  stripe_details_submitted INTEGER NOT NULL DEFAULT 0, -- finished Stripe onboarding
  google_review_url TEXT,        -- shop's Google review link (for the review handoff)
  loyalty_enabled INTEGER NOT NULL DEFAULT 0,
  loyalty_threshold INTEGER NOT NULL DEFAULT 5,   -- completed visits per reward
  loyalty_type TEXT NOT NULL DEFAULT 'amount',    -- 'amount' | 'percent'
  loyalty_value INTEGER NOT NULL DEFAULT 2000,    -- cents (amount) or percent
  gift_cards_enabled INTEGER NOT NULL DEFAULT 0,  -- sell gift cards online (needs Stripe connected)
  gift_card_expiry_years INTEGER NOT NULL DEFAULT 3,  -- validity from purchase; min 3 (AU law)
  legal_name TEXT,               -- registered business name for tax invoices
  abn TEXT,                      -- Australian Business Number (or tax id)
  gst_registered INTEGER NOT NULL DEFAULT 0,  -- show GST (1/11) on tax invoices
  invoice_footer TEXT,           -- extra notes printed on invoices/receipts
  health_fund_receipts INTEGER NOT NULL DEFAULT 0,  -- offer private-health rebate receipts
  waitlist_enabled INTEGER NOT NULL DEFAULT 0,      -- let customers join a waitlist when full
  no_show_fee_enabled INTEGER NOT NULL DEFAULT 0,   -- charge/record a no-show fee
  no_show_fee_type TEXT NOT NULL DEFAULT 'amount',  -- amount | percent
  no_show_fee_value INTEGER NOT NULL DEFAULT 0,     -- cents (amount) or percent of price
  intake_enabled INTEGER NOT NULL DEFAULT 0,        -- ask customers to complete a health intake form
  is_published INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shops_owner ON shops(owner_id);

-- Services offered (e.g. "60min Deep Tissue")
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  price_cents INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Massage',
  modality TEXT,                 -- e.g. "Remedial Massage" (health-fund receipts)
  item_code TEXT,                -- health-fund item/service code (optional)
  rebatable INTEGER NOT NULL DEFAULT 0,  -- eligible for a private-health rebate receipt
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_services_shop ON services(shop_id, is_active);

-- Therapist login accounts. One account can be linked to many shops' staff
-- rows (a therapist who works at several shops uses ONE login for all of them).
CREATE TABLE IF NOT EXISTS therapists (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS therapist_sessions (
  id TEXT PRIMARY KEY,
  therapist_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (therapist_id) REFERENCES therapists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_therapist_sessions ON therapist_sessions(therapist_id);

-- Therapists / massage staff (one row per shop the therapist works at)
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT DEFAULT 'Massage Therapist',
  bio TEXT,
  emoji TEXT NOT NULL DEFAULT '🧑‍⚕️',
  token TEXT,                     -- secret self-service link so the therapist can set their own hours
  therapist_id TEXT,              -- linked therapist login account (nullable)
  email TEXT,                     -- used to auto-link this row to a therapist account
  commission_pct INTEGER NOT NULL DEFAULT 0,  -- % of service revenue paid to this therapist
  provider_no TEXT,               -- health-fund provider number (for rebate receipts)
  qualification TEXT,             -- e.g. "Dip. Remedial Massage" (shown on receipts)
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_staff_shop ON staff(shop_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_token ON staff(token);
CREATE INDEX IF NOT EXISTS idx_staff_therapist ON staff(therapist_id);
CREATE INDEX IF NOT EXISTS idx_staff_email ON staff(email);

-- Which staff can perform which services (absence of rows for a service = all staff)
CREATE TABLE IF NOT EXISTS staff_services (
  staff_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  PRIMARY KEY (staff_id, service_id),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
);

-- Weekly working hours, per staff member
CREATE TABLE IF NOT EXISTS availability (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,   -- 0 = Sunday .. 6 = Saturday
  start_time TEXT NOT NULL,       -- 'HH:MM'
  end_time TEXT NOT NULL,
  UNIQUE(staff_id, day_of_week),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);

-- Loyalty reward tiers per shop (milestones, e.g. 5 visits = $20, 10 = $50).
-- Saved end-of-day reconciliation sheets (editable cash-up). One per shop+date;
-- data is a JSON map of cell key -> value.
CREATE TABLE IF NOT EXISTS day_sheets (
  shop_id TEXT NOT NULL,
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (shop_id, date),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  visits INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'amount',   -- 'amount' | 'percent'
  value INTEGER NOT NULL,                 -- cents (amount) or percent
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_loyalty_tiers_shop ON loyalty_tiers(shop_id, visits);

-- One row per redeemed reward (per client + milestone), linked to the booking.
CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  milestone INTEGER NOT NULL,             -- the tier's visit count that was redeemed
  discount_cents INTEGER NOT NULL DEFAULT 0,
  booking_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_client ON loyalty_redemptions(client_id, milestone);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_booking ON loyalty_redemptions(booking_id);

-- Cache of Workers-AI translations of owner content (service names/descriptions,
-- tagline, about) into each customer language. Keyed by (lang, hash of source).
CREATE TABLE IF NOT EXISTS translations (
  lang TEXT NOT NULL,
  src_hash TEXT NOT NULL,
  src TEXT,
  translated TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (lang, src_hash)
);

-- Reviews left by clients. Kept internally; high ratings are offered a Google
-- review handoff (shops.google_review_url).
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  booking_id TEXT,
  client_id TEXT,
  staff_name TEXT,
  customer_name TEXT,
  rating INTEGER NOT NULL,        -- 1..5
  body TEXT,
  shared_google INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON reviews(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_booking ON reviews(booking_id);

-- Saved clients per shop — so repeat walk-ins/callers are selected, not retyped.
-- `notes` holds persistent notes the shop keeps on the client (insurance, prefs,
-- behaviour flags like "rude", etc.).
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  notes TEXT,
  loyalty_redeemed INTEGER NOT NULL DEFAULT 0,  -- loyalty rewards already redeemed
  intake_json TEXT,               -- completed health intake form (JSON)
  intake_at INTEGER,              -- when the intake form was last completed
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clients_shop ON clients(shop_id);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(shop_id, email);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(shop_id, phone);

-- Gift cards: bought online (Stripe Connect), redeemed at the shop.
CREATE TABLE IF NOT EXISTS gift_cards (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,        -- human-friendly, e.g. SER-4F9K-QP2M
  initial_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | active | redeemed | void
  purchaser_name TEXT,
  purchaser_email TEXT,
  recipient_name TEXT,
  recipient_email TEXT,
  message TEXT,
  lang TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  activated_at INTEGER,             -- set when payment completes
  expires_at INTEGER,               -- unix seconds; null = no expiry
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_giftcards_shop ON gift_cards(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_giftcards_code ON gift_cards(code);

-- Redemption / top-up ledger (negative = redeemed toward a booking; positive = restore/refund).
CREATE TABLE IF NOT EXISTS gift_card_txns (
  id TEXT PRIMARY KEY,
  gift_card_id TEXT NOT NULL,
  booking_id TEXT,
  amount_cents INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (gift_card_id) REFERENCES gift_cards(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gctxn_card ON gift_card_txns(gift_card_id, created_at);

-- Payments collected against a booking (in addition to any online deposit):
-- cash in person, an external card machine, bank transfer, or Alisa's Stripe QR.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,         -- service payment portion
  tip_cents INTEGER NOT NULL DEFAULT 0,  -- tip portion (on top of amount_cents)
  method TEXT NOT NULL DEFAULT 'cash',   -- cash | card | transfer | other
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_shop ON payments(shop_id, created_at);

-- Prepaid session bundles a shop offers (e.g. "5 x 60min massage").
CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  service_id TEXT,               -- null = any service
  sessions INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  expiry_days INTEGER NOT NULL DEFAULT 365,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_packages_shop ON packages(shop_id);

-- A package a customer bought (tracks remaining sessions).
CREATE TABLE IF NOT EXISTS client_packages (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  package_id TEXT,
  client_id TEXT,
  name TEXT NOT NULL,
  service_id TEXT,
  code TEXT NOT NULL UNIQUE,
  sessions_total INTEGER NOT NULL,
  sessions_used INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | active | used | void
  purchaser_name TEXT, purchaser_email TEXT, lang TEXT,
  stripe_session_id TEXT, stripe_payment_intent_id TEXT, stripe_charge_id TEXT,
  activated_at INTEGER, expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clientpkg_shop ON client_packages(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clientpkg_code ON client_packages(code);

-- Membership plans a shop offers (recurring).
CREATE TABLE IF NOT EXISTS membership_plans (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  interval TEXT NOT NULL DEFAULT 'month',  -- month | year
  discount_pct INTEGER NOT NULL DEFAULT 0,
  included_sessions INTEGER NOT NULL DEFAULT 0,  -- included per period
  benefits TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memplans_shop ON membership_plans(shop_id);

-- A customer's active membership (Stripe subscription).
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  plan_id TEXT,
  client_id TEXT,
  name TEXT, email TEXT, lang TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | active | past_due | canceled
  discount_pct INTEGER NOT NULL DEFAULT 0,
  included_sessions INTEGER NOT NULL DEFAULT 0,
  sessions_used INTEGER NOT NULL DEFAULT 0,  -- this period
  stripe_customer_id TEXT, stripe_subscription_id TEXT,
  current_period_end INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memberships_shop ON memberships(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memberships_sub ON memberships(stripe_subscription_id);

-- Waitlist: customers who want a slot on a day that's full; notified on a cancellation.
CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  service_id TEXT,
  staff_id TEXT,                 -- null = any therapist
  date TEXT,                     -- preferred date 'YYYY-MM-DD' (null = any)
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  note TEXT,
  lang TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',  -- waiting | notified | booked | cancelled
  notified_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_waitlist_shop ON waitlist(shop_id, date, status);

-- Optional booking add-ons / upsells (e.g. "Hot stones +$20", "+30 min").
CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_addons_shop ON addons(shop_id);

-- Days a therapist is off (holidays, sick days) — blocks that whole date
CREATE TABLE IF NOT EXISTS time_off (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  date TEXT NOT NULL,             -- 'YYYY-MM-DD' in the shop timezone
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(staff_id, date),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_time_off_staff ON time_off(staff_id, date);

-- Customer appointments
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  start_time INTEGER NOT NULL,    -- unix seconds (UTC)
  end_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | confirmed | completed | cancelled | no_show
  price_cents INTEGER NOT NULL DEFAULT 0,
  deposit_cents INTEGER NOT NULL DEFAULT 0,
  service_name TEXT,
  staff_name TEXT,
  notes TEXT,
  lang TEXT,                      -- customer's language at booking time (for localized emails)
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  paid_cents INTEGER NOT NULL DEFAULT 0,   -- extra in-person/QR payments collected (beyond any deposit)
  refunded_at INTEGER,
  reminder_sent_at INTEGER,       -- set once a day-before reminder email has gone out
  client_id TEXT,                 -- linked saved client (nullable)
  requested_staff INTEGER NOT NULL DEFAULT 0,  -- client specifically requested this therapist (don't reassign)
  group_id TEXT,                  -- links bookings made together (couples / group)
  room TEXT,                      -- optional room label (e.g. "Couple Room 1")
  loyalty_applied INTEGER NOT NULL DEFAULT 0,  -- loyalty discount applied to this booking (cents)
  gift_applied INTEGER NOT NULL DEFAULT 0,     -- gift-card credit redeemed toward this booking (cents)
  gift_card_id TEXT,                           -- gift card redeemed on this booking (nullable)
  covered_by TEXT,                             -- 'package' | 'membership' when a prepaid session covers this booking
  no_show_fee_cents INTEGER NOT NULL DEFAULT 0,-- fee recorded when marked no-show
  addons_json TEXT,                            -- selected add-ons [{name,price_cents}]
  addons_cents INTEGER NOT NULL DEFAULT 0,     -- total add-on price added to this booking
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE,
  FOREIGN KEY (service_id) REFERENCES services(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
CREATE INDEX IF NOT EXISTS idx_bookings_shop ON bookings(shop_id, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_staff ON bookings(staff_id, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_stripe ON bookings(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
