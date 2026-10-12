-- Successful fetch-start cursor: failed imports/pages never advance it.
CREATE TABLE IF NOT EXISTS da_application_sync_state (
  task_id TEXT PRIMARY KEY,
  last_successful_fetch_at TIMESTAMPTZ,
  last_recovery_at TIMESTAMPTZ
);
-- Source versions and durable cancellation retries, independent of the cursor.
CREATE TABLE IF NOT EXISTS da_application_source_sync (
  application_id TEXT PRIMARY KEY,
  source_fingerprint TEXT NOT NULL,
  source_modified_on TEXT,
  cancellation_pending BOOLEAN NOT NULL DEFAULT false,
  cancellation_error TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS da_source_cancellation_pending_idx
  ON da_application_source_sync (application_id) WHERE cancellation_pending;
ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS unchanged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS cancelled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS recovery BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS last_update_date DATE;
