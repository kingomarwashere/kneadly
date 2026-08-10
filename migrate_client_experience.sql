-- Phase 5: intake forms + booking add-ons. Run once.
ALTER TABLE shops ADD COLUMN intake_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN addons_json TEXT;
ALTER TABLE bookings ADD COLUMN addons_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN intake_json TEXT;
ALTER TABLE clients ADD COLUMN intake_at INTEGER;

CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0, duration_minutes INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_addons_shop ON addons(shop_id);
