-- Let shops choose what to charge at booking: none | deposit | full. Run once.
ALTER TABLE shops ADD COLUMN charge_mode TEXT NOT NULL DEFAULT 'deposit';
-- Preserve current behaviour: shops with deposit 0% were effectively "no upfront charge".
UPDATE shops SET charge_mode='none' WHERE deposit_pct = 0;
