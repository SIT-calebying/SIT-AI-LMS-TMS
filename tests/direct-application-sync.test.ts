import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationsToSync, directApplicationFingerprint, directApplicationSyncWindow, directApplicationRecoveryDue } from '../lib/directApplicationSync';

test('initial recent pull starts yesterday; independent recovery covers 180 days', () => {
  const now = new Date('2026-10-12T01:00:00Z');
  assert.deepEqual(directApplicationSyncWindow({}, now), {
    lastUpdateDate: '2026-10-11', recovery: false, today: '2026-10-12', tomorrow: '2026-10-13',
  });
  assert.deepEqual(directApplicationSyncWindow({}, now, 'recovery'), {
    lastUpdateDate: '2026-04-15', recovery: true, today: '2026-10-12', tomorrow: '2026-10-13',
  });
  const state = { last_successful_fetch_at: '2026-10-11T16:30:00Z', last_recovery_at: '2026-10-06T01:00:00Z' };
  assert.equal(directApplicationSyncWindow(state, now).lastUpdateDate, '2026-10-11');
  assert.equal(directApplicationSyncWindow(state, now).recovery, false);
  assert.equal(directApplicationRecoveryDue(state, now), false);
  assert.equal(directApplicationRecoveryDue({ last_recovery_at: '2026-10-05T01:00:00Z' }, now), true);
  assert.equal(directApplicationRecoveryDue({}, now), true);
  assert.equal(directApplicationSyncWindow({ ...state, last_recovery_at: null }, now).lastUpdateDate, '2026-10-11');
});

test('after downtime the cursor resumes from the last successful date rather than yesterday', () => {
  const window = directApplicationSyncWindow({
    last_successful_fetch_at: '2026-10-08T01:00:00Z', last_recovery_at: '2026-10-06T01:00:00Z',
  }, new Date('2026-10-12T01:00:00Z'));
  assert.equal(window.lastUpdateDate, '2026-10-07');
});

test('existing updates/cancellations and new confirmed registrations are limited to tomorrow onward', () => {
  const row = (id: string, status: string, date = '2026-10-15') => ({
    'Application ID': id, 'Application Status': status, 'Course Start Date': date,
  });
  const rows = applicationsToSync([
    row('existing-cancel', 'Cancelled', '2026-10-13'), row('existing-update', 'Confirmed', '2026-10-15'),
    row('existing-today', 'Cancelled', '2026-10-12'), row('existing-past', 'Confirmed', '2026-10-10'),
    row('existing-pending', 'Pending', ''), row('new', 'Confirmed (Pending payment)'),
    row('new-pending', 'Confirm application'), row('new-cancel', 'Cancelled'),
    row('new-past', 'Confirmed', '2026-10-10'), row('new-undated', 'Confirmed', ''),
    row('new', 'Confirmed (Pending payment)'),
  ], new Set(['existing-cancel', 'existing-update', 'existing-pending', 'existing-today', 'existing-past']), '2026-10-13');
  assert.deepEqual(rows.map(r => r['Application ID']), ['existing-cancel', 'existing-update', 'new']);
});

test('source fingerprints detect new details even without modifiedOn and ignore property ordering', () => {
  const row = { 'Application ID': 'A', 'Application Status': 'Confirmed', 'Trainee Email': 'old@example.test' };
  assert.equal(directApplicationFingerprint(row), directApplicationFingerprint({ ...Object.fromEntries(Object.entries(row).reverse()) }));
  assert.notEqual(directApplicationFingerprint(row), directApplicationFingerprint({ ...row, 'Trainee Email': 'new@example.test' }));
  assert.notEqual(directApplicationFingerprint(row), directApplicationFingerprint({ ...row, 'Application Status': 'Cancelled' }));
});
