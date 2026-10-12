import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationsToSync, directApplicationFingerprint, directApplicationSyncWindow } from '../lib/directApplicationSync';

test('first fetch and weekly recovery cover 180 days, regular pulls overlap one Singapore day', () => {
  const now = new Date('2026-10-12T01:00:00Z');
  assert.deepEqual(directApplicationSyncWindow({}, now), {
    lastUpdateDate: '2026-04-15', recovery: true, today: '2026-10-12',
  });
  const state = { last_successful_fetch_at: '2026-10-11T16:30:00Z', last_recovery_at: '2026-10-06T01:00:00Z' };
  assert.equal(directApplicationSyncWindow(state, now).lastUpdateDate, '2026-10-11');
  assert.equal(directApplicationSyncWindow(state, now).recovery, false);
  assert.equal(directApplicationSyncWindow({ ...state, last_recovery_at: '2026-10-05T01:00:00Z' }, now).recovery, true);
});

test('after downtime the cursor resumes from the last successful date rather than yesterday', () => {
  const window = directApplicationSyncWindow({
    last_successful_fetch_at: '2026-10-08T01:00:00Z', last_recovery_at: '2026-10-06T01:00:00Z',
  }, new Date('2026-10-12T01:00:00Z'));
  assert.equal(window.lastUpdateDate, '2026-10-07');
});

test('existing applications sync every status and past/unknown dates; only new confirmed upcoming ones import', () => {
  const row = (id: string, status: string, date = '2026-10-15') => ({
    'Application ID': id, 'Application Status': status, 'Course Start Date': date,
  });
  const rows = applicationsToSync([
    row('existing-cancel', 'Cancelled', '2026-10-10'), row('existing-update', 'Confirmed', '2026-10-01'),
    row('existing-pending', 'Pending', ''), row('new', 'Confirmed (Pending payment)'),
    row('new-pending', 'Confirm application'), row('new-cancel', 'Cancelled'),
    row('new-past', 'Confirmed', '2026-10-10'), row('new-undated', 'Confirmed', ''),
    row('new', 'Confirmed (Pending payment)'),
  ], new Set(['existing-cancel', 'existing-update', 'existing-pending']), '2026-10-12');
  assert.deepEqual(rows.map(r => r['Application ID']), ['existing-cancel', 'existing-update', 'existing-pending', 'new']);
});

test('source fingerprints detect new details even without modifiedOn and ignore property ordering', () => {
  const row = { 'Application ID': 'A', 'Application Status': 'Confirmed', 'Trainee Email': 'old@example.test' };
  assert.equal(directApplicationFingerprint(row), directApplicationFingerprint({ ...Object.fromEntries(Object.entries(row).reverse()) }));
  assert.notEqual(directApplicationFingerprint(row), directApplicationFingerprint({ ...row, 'Trainee Email': 'new@example.test' }));
  assert.notEqual(directApplicationFingerprint(row), directApplicationFingerprint({ ...row, 'Application Status': 'Cancelled' }));
});
