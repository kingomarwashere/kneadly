-- Gift cards feature. Idempotent-ish: run once on the live D1.
ALTER TABLE shops ADD COLUMN gift_cards_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shops ADD COLUMN gift_card_expiry_years INTEGER NOT NULL DEFAULT 3;
ALTER TABLE bookings ADD COLUMN gift_applied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN gift_card_id TEXT;

CREATE TABLE IF NOT EXISTS gift_cards (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  initial_cents INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment',
  purchaser_name TEXT,
  purchaser_email TEXT,
  recipient_name TEXT,
  recipient_email TEXT,
  message TEXT,
  lang TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  activated_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_giftcards_shop ON gift_cards(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_giftcards_code ON gift_cards(code);

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
