-- Phase 4: waitlist + no-show fees. Run once.
ALTER TABLE shops ADD COLUMN waitlist_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN no_show_fee_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN no_show_fee_type TEXT NOT NULL DEFAULT 'amount';
ALTER TABLE shops ADD COLUMN no_show_fee_value INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN no_show_fee_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY, shop_id TEXT NOT NULL, service_id TEXT, staff_id TEXT, date TEXT,
  name TEXT NOT NULL, email TEXT, phone TEXT, note TEXT, lang TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', notified_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_waitlist_shop ON waitlist(shop_id, date, status);
