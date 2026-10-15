// Backfills trainer_profile.country and trainer_profile.areas_of_expertise
// (shown as "Domains" on the admin Search Trainers page) from the legacy TMS
// Google Sheet's Trainer tab.
//
// country             <- Country column   (only when the DB value is blank)
// areas_of_expertise  <- Domain column    (only when the DB list is empty)
//
// Never overwrites a value that is already set. Match: email first, then name
// (full_name | common_name).
//
// Usage:
//   node scripts/import-trainer-country-domains.js          # dry-run
//   node scripts/import-trainer-country-domains.js --apply  # write to DB

const { Pool } = require('pg');
const https = require('https');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1lLphFYcwV_h2gyYeviO4kbF0yb4AfMZ4TKzy9DqW3b8/export?format=csv&gid=298101537';
const APPLY = process.argv.includes('--apply');

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const get = (u) =>
      https
        // agent:false — Node's default keep-alive agent would hold the process open after the run.
        .get(u, { agent: false }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
            return get(res.headers.location);
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    get(url);
  });
}

function parseCSV(text) {
  const rows = [];
  let cur = '',
    inQ = false,
    row = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') {
        row.push(cur.trim());
        cur = '';
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(cur.trim());
        rows.push(row);
        cur = '';
        row = [];
        if (ch === '\r') i++;
      } else cur += ch;
    }
  }
  if (cur || row.length) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rows;
}

const normName = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const splitEmails = (cell) =>
  (cell || '')
    .split(/[;,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));

// "ICT, Marketing" / "ICT / Media" -> ['ICT', 'Marketing'], deduped case-insensitively.
function splitDomains(cell) {
  const seen = new Set();
  const out = [];
  for (const t of (cell || '').split(/[,;|/]/).map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

const isEmptyList = (v) => !Array.isArray(v) || v.length === 0;

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
      ? { rejectUnauthorized: false }
      : false,
  });

  console.log(APPLY ? '🔧 APPLY MODE' : '🔍 DRY-RUN (pass --apply to write)');
  console.log('Fetching sheet...');
  const rows = parseCSV(await fetchCSV(SHEET_URL));
  const header = rows[0].map((h) => h.toLowerCase());
  const eIdx = header.indexOf('email'),
    fnIdx = header.indexOf('full name'),
    countryIdx = header.indexOf('country'),
    domIdx = header.indexOf('domain');
  if ([eIdx, fnIdx, countryIdx, domIdx].includes(-1)) {
    console.error('Sheet header changed — expected Email, Full Name, Country, Domain columns.');
    process.exit(1);
  }

  const byEmail = new Map();
  const byName = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const payload = { country: (r[countryIdx] || '').trim(), domains: splitDomains(r[domIdx]) };
    if (!payload.country && !payload.domains.length) continue;
    for (const e of splitEmails(r[eIdx])) byEmail.set(e, payload);
    const nk = normName(r[fnIdx]);
    if (nk) byName.set(nk, payload);
  }
  console.log(`Sheet rows with country/domain data: emails=${byEmail.size}, names=${byName.size}`);

  const trainers = await pool.query(`
    SELECT tp.user_id, au.email, au.secondary_email, au.full_name, tp.common_name,
           tp.country,
           CASE WHEN jsonb_typeof(tp.areas_of_expertise) = 'array'
                THEN tp.areas_of_expertise ELSE '[]'::jsonb END AS areas_of_expertise
    FROM trainer_profile tp
    JOIN app_user au ON tp.user_id = au.id
    ORDER BY au.full_name
  `);

  const updates = [];
  const unmatched = [];
  let complete = 0;
  for (const t of trainers.rows) {
    const needCountry = !(t.country || '').trim();
    const needDomains = isEmptyList(t.areas_of_expertise);
    if (!needCountry && !needDomains) {
      complete++;
      continue;
    }

    let payload = null;
    let how = 'email';
    for (const e of [t.email, t.secondary_email]) {
      const k = (e || '').trim().toLowerCase();
      if (k && byEmail.has(k)) { payload = byEmail.get(k); break; }
    }
    if (!payload) {
      how = 'name';
      for (const cand of [t.full_name, t.common_name]) {
        const nk = normName(cand);
        if (nk && byName.has(nk)) { payload = byName.get(nk); break; }
      }
    }
    if (!payload) {
      unmatched.push(t.full_name);
      continue;
    }

    const country = needCountry && payload.country ? payload.country : null;
    const domains = needDomains && payload.domains.length ? payload.domains : null;
    if (!country && !domains) {
      unmatched.push(`${t.full_name} (matched by ${how}, but sheet has no value for the missing field)`);
      continue;
    }
    updates.push({ user_id: t.user_id, full_name: t.full_name, how, country, domains });
  }

  console.log(`\nTrainers in DB: ${trainers.rows.length}`);
  console.log(`Already have country + domains: ${complete}`);
  console.log(`Will update: ${updates.length} ` +
    `(country: ${updates.filter((u) => u.country).length}, domains: ${updates.filter((u) => u.domains).length})`);
  for (const u of updates) {
    const parts = [];
    if (u.country) parts.push(`country=${u.country}`);
    if (u.domains) parts.push(`domains=${u.domains.join(', ')}`);
    console.log(`  • ${u.full_name} [${u.how}] ${parts.join(' | ')}`);
  }
  if (unmatched.length) {
    console.log(`\nNot updated (${unmatched.length}):`);
    for (const n of unmatched) console.log(`  - ${n}`);
  }

  if (APPLY && updates.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        // Re-check emptiness in the WHERE so a value entered since the read is never overwritten.
        if (u.country) {
          await client.query(
            `UPDATE trainer_profile SET country = $1 WHERE user_id = $2 AND COALESCE(TRIM(country), '') = ''`,
            [u.country, u.user_id],
          );
        }
        if (u.domains) {
          await client.query(
            `UPDATE trainer_profile SET areas_of_expertise = $1::jsonb
             WHERE user_id = $2
               AND (areas_of_expertise IS NULL OR jsonb_typeof(areas_of_expertise) <> 'array'
                    OR jsonb_array_length(areas_of_expertise) = 0)`,
            [JSON.stringify(u.domains), u.user_id],
          );
        }
      }
      await client.query('COMMIT');
      console.log(`\n✅ Applied ${updates.length} trainer updates.`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else if (!APPLY) {
    console.log('\nDry-run only. Re-run with --apply to write these changes.');
  }

  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
