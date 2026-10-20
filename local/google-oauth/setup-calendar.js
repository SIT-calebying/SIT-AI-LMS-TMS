#!/usr/bin/env node
'use strict';
/**
 * One-shot Google Calendar setup for the local AI-LMS-TMS stack (git-excluded, dev only).
 *
 *   node local/google-oauth/setup-calendar.js [--open]
 *
 * Reads GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET from .env (a Google "Desktop app" OAuth client),
 * then:
 *   1. starts a loopback listener and prints the Google consent URL (PKCE + state; --open also opens it)
 *   2. exchanges the returned code for a refresh token (never printed)
 *   3. creates a dedicated secondary calendar "LMS-TMS Test" (reuses GOOGLE_TEST_CALENDAR_ID if already set)
 *   4. stores client id/secret/refresh token + calendar id in the database (training_provider) and the refresh
 *      token + calendar id in .env (+ an optional backup copy via ENV_BACKUP_FILE)
 * It requests ONLY the scope calendar.app.created: the app can then see/create/change/delete events solely on
 * secondary calendars this client created, so it cannot touch the primary calendar. It does NOT switch
 * sync_google_calendar on.
 *
 * Test hooks (env): ENV_FILE, AUTH_URL, TOKEN_URL, CAL_API, NO_DB=1, NO_BACKUP=1.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_FILE = process.env.ENV_FILE || path.join(ROOT, '.env');
const BACKUP = process.env.ENV_BACKUP_FILE || ''; // optional: copy of .env to refresh after writing
const AUTH_URL = process.env.AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.TOKEN_URL || 'https://oauth2.googleapis.com/token';
const CAL_API = (process.env.CAL_API || 'https://www.googleapis.com/calendar/v3').replace(/\/+$/, '');
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const LOGIN_HINT = process.env.LOGIN_HINT || '';
const CAL_NAME = 'LMS-TMS Test';
const WANT_OPEN = process.argv.includes('--open');

const readEnv = () => {
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
};
const writeEnv = (updates) => {
  let t = fs.readFileSync(ENV_FILE, 'utf8');
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    t = re.test(t) ? t.replace(re, () => `${k}=${v}`) : `${t.replace(/\n*$/, '\n')}${k}=${v}\n`;
  }
  fs.writeFileSync(ENV_FILE, t, { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  if (BACKUP && !process.env.NO_BACKUP && fs.existsSync(path.dirname(BACKUP))) { fs.copyFileSync(ENV_FILE, BACKUP); fs.chmodSync(BACKUP, 0o600); }
};
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const die = (msg) => { console.error('\n✖ ' + msg); process.exit(1); };
const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

(async () => {
  const env = readEnv();
  const clientId = (env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) die('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in .env first (Desktop-app OAuth client).');

  // ── 1. loopback consent ────────────────────────────────────────────────────
  const state = b64url(crypto.randomBytes(18));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const done = (status, html) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
      if (u.searchParams.get('error')) { done(400, '<h3>Google returned an error. You can close this tab.</h3>'); server.close(); return reject(new Error('Google returned error: ' + u.searchParams.get('error'))); }
      if (u.searchParams.get('state') !== state) { done(400, '<h3>State mismatch.</h3>'); return; }
      const c = u.searchParams.get('code');
      if (!c) { done(400, '<h3>No code.</h3>'); return; }
      done(200, '<h3>Authorised. You can close this tab and return to the terminal.</h3>');
      server.close(); resolve(c);
    });
    server.listen(0, '127.0.0.1', () => {
      const redirect = `http://127.0.0.1:${server.address().port}/callback`;
      server.redirectUri = redirect;
      const url = new URL(AUTH_URL);
      for (const [k, v] of Object.entries({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline',
        prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256', login_hint: LOGIN_HINT,
      })) url.searchParams.set(k, v);
      global.__redirect = redirect;
      console.log('\nOpen this URL in your browser and sign in' + (LOGIN_HINT ? ' as ' + LOGIN_HINT : '') + ':\n\n' + url.toString() + '\n');
      console.log('Waiting for consent (5 minute timeout)…');
      if (WANT_OPEN) spawn('open', [url.toString()], { stdio: 'ignore', detached: true }).unref();
    });
    setTimeout(() => { server.close(); reject(new Error('Timed out waiting for consent.')); }, 5 * 60 * 1000).unref();
  }).catch((e) => die(e.message));

  // ── 2. code -> tokens ──────────────────────────────────────────────────────
  const tr = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: global.__redirect, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok || !tj.access_token) die(`Token exchange failed (HTTP ${tr.status}): ${tj.error || ''} ${tj.error_description || ''}`.trim());
  if (!tj.refresh_token) die('Google returned no refresh_token. Revoke this app at https://myaccount.google.com/permissions and run again.');
  console.log('✔ Consent received, refresh token obtained (not shown).');

  // ── 3. dedicated calendar ──────────────────────────────────────────────────
  let calendarId = (env.GOOGLE_TEST_CALENDAR_ID || '').trim();
  if (calendarId) {
    const chk = await fetch(`${CAL_API}/calendars/${encodeURIComponent(calendarId)}`, { headers: { Authorization: `Bearer ${tj.access_token}` } });
    if (!chk.ok) { console.log(`! Stored calendar ${calendarId} is not accessible (HTTP ${chk.status}); creating a new one.`); calendarId = ''; }
    else console.log(`✔ Reusing existing test calendar ${calendarId}`);
  }
  if (!calendarId) {
    const cr = await fetch(`${CAL_API}/calendars`, {
      method: 'POST', headers: { Authorization: `Bearer ${tj.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: CAL_NAME, description: 'Dedicated test calendar for the local AI-LMS-TMS stack. Safe to delete.', timeZone: 'Asia/Singapore' }),
    });
    const cj = await cr.json().catch(() => ({}));
    if (!cr.ok || !cj.id) die(`Calendar creation failed (HTTP ${cr.status}): ${JSON.stringify(cj.error || cj).slice(0, 300)}`);
    calendarId = cj.id;
    console.log(`✔ Created calendar "${CAL_NAME}": ${calendarId}`);
  }

  // ── 4. persist ─────────────────────────────────────────────────────────────
  writeEnv({ GOOGLE_OAUTH_REFRESH_TOKEN: tj.refresh_token, GOOGLE_TEST_CALENDAR_ID: calendarId });
  console.log('✔ .env updated (refresh token + calendar id) and backup refreshed.');

  if (!process.env.NO_DB) {
    const sql = `UPDATE public.training_provider SET google_client_id=${sqlStr(clientId)}, google_client_secret=${sqlStr(clientSecret)}, ` +
      `google_refresh_token=${sqlStr(tj.refresh_token)}, google_calendar_url=${sqlStr(calendarId)}, updated_at=NOW();\n`;
    const r = spawnSync('docker', ['compose', 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'lmsdb', '-v', 'ON_ERROR_STOP=1', '-q'],
      { cwd: ROOT, input: sql, encoding: 'utf8' });
    if (r.status !== 0) die('Could not write the credentials to the database: ' + (r.stderr || '').split('\n').filter((l) => !/obsolete/.test(l)).join(' ').slice(0, 300));
    console.log('✔ training_provider updated (google_client_id/secret/refresh_token, google_calendar_url).');
  }
  console.log(`\nDone. Calendar: https://calendar.google.com/calendar/u/0/r?cid=${Buffer.from(calendarId).toString('base64').replace(/=+$/, '')}`);
  console.log('sync_google_calendar is still OFF and ENABLE_CALENDAR_WRITES is unchanged — nothing writes to the calendar yet.');
})();
