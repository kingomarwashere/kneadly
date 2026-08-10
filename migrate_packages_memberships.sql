-- Phase 3: packages + memberships. Run once.
CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, name TEXT NOT NULL, service_id TEXT,
  sessions INTEGER NOT NULL, price_cents INTEGER NOT NULL, expiry_days INTEGER NOT NULL DEFAULT 365,
  is_active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_packages_shop ON packages(shop_id);

CREATE TABLE IF NOT EXISTS client_packages (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, package_id TEXT, client_id TEXT,
  name TEXT NOT NULL, service_id TEXT, code TEXT NOT NULL UNIQUE,
  sessions_total INTEGER NOT NULL, sessions_used INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_payment',
  purchaser_name TEXT, purchaser_email TEXT, lang TEXT,
  stripe_session_id TEXT, stripe_payment_intent_id TEXT, stripe_charge_id TEXT,
  activated_at INTEGER, expires_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clientpkg_shop ON client_packages(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clientpkg_code ON client_packages(code);

CREATE TABLE IF NOT EXISTS membership_plans (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, name TEXT NOT NULL, price_cents INTEGER NOT NULL,
  interval TEXT NOT NULL DEFAULT 'month', discount_pct INTEGER NOT NULL DEFAULT 0,
  included_sessions INTEGER NOT NULL DEFAULT 0, benefits TEXT, is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memplans_shop ON membership_plans(shop_id);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, plan_id TEXT, client_id TEXT,
  name TEXT, email TEXT, lang TEXT, status TEXT NOT NULL DEFAULT 'pending',
  discount_pct INTEGER NOT NULL DEFAULT 0, included_sessions INTEGER NOT NULL DEFAULT 0,
  sessions_used INTEGER NOT NULL DEFAULT 0, stripe_customer_id TEXT, stripe_subscription_id TEXT,
  current_period_end INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_memberships_shop ON memberships(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memberships_sub ON memberships(stripe_subscription_id);

ALTER TABLE bookings ADD COLUMN covered_by TEXT;
