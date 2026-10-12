import pool from './db';

// Matches database/migrations/add-da-automation-run.sql. Existing installs apply
// this idempotently on first use, including deployments without a migration CLI.
let ready: Promise<void> | undefined;
export function ensureDaAutomationTable(): Promise<void> {
  if (!ready) ready = initialize().catch(error => { ready = undefined; throw error; });
  return ready;
}

async function initialize(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Separate namespace from row/session locks. Serialise first-use DDL across replicas.
    await client.query('SELECT pg_advisory_xact_lock(17401, 1)');
    await client.query(`
    CREATE TABLE IF NOT EXISTS da_automation_run (
      id UUID PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed', 'interrupted')),
      fetched INTEGER NOT NULL DEFAULT 0, imported INTEGER NOT NULL DEFAULT 0,
      attempted INTEGER NOT NULL DEFAULT 0, enrolled INTEGER NOT NULL DEFAULT 0,
      already_enrolled INTEGER NOT NULL DEFAULT 0, deferred INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0, errors JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS da_automation_run_started_idx ON da_automation_run (started_at DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS da_application_sync_state (
        task_id TEXT PRIMARY KEY, last_successful_fetch_at TIMESTAMPTZ, last_recovery_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS da_application_source_sync (
        application_id TEXT PRIMARY KEY, source_fingerprint TEXT NOT NULL, source_modified_on TEXT,
        cancellation_pending BOOLEAN NOT NULL DEFAULT false, cancellation_error TEXT,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS da_source_cancellation_pending_idx
        ON da_application_source_sync (application_id) WHERE cancellation_pending;
      ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS unchanged INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS cancelled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS recovery BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE da_automation_run ADD COLUMN IF NOT EXISTS last_update_date DATE
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
