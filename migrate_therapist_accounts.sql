-- Migration: proper therapist login accounts that span multiple shops.
-- Run once against an existing DB (schema.sql carries these for fresh installs).
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

ALTER TABLE staff ADD COLUMN therapist_id TEXT;
ALTER TABLE staff ADD COLUMN email TEXT;
CREATE INDEX IF NOT EXISTS idx_staff_therapist ON staff(therapist_id);
CREATE INDEX IF NOT EXISTS idx_staff_email ON staff(email);
