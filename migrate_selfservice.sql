-- One-off migration: therapist self-service links + days off.
-- Safe to run once against an existing DB (schema.sql already carries these for fresh installs).
ALTER TABLE staff ADD COLUMN token TEXT;
UPDATE staff SET token = lower(hex(randomblob(20))) WHERE token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_token ON staff(token);

CREATE TABLE IF NOT EXISTS time_off (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  date TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(staff_id, date),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_time_off_staff ON time_off(staff_id, date);
