'use strict';
/**
 * Local Anthropic-API shim for AI-LMS-TMS (dev only).
 *
 * The app hardcodes Anthropic model names (claude-opus-5, claude-sonnet-4-6, claude-haiku-4-5-20251001, ...)
 * and talks to ANTHROPIC_BASE_URL. ai-gateway-dev (LiteLLM) exposes the same models under prefixed names
 * (baseline-eus2/claude-opus-5, ...). This shim:
 *   - rewrites the `model` field of JSON request bodies to the gateway's name
 *   - replaces whatever credential the app sent with GATEWAY_KEY (so the real key lives only in .env)
 *   - forwards to GATEWAY_URL unchanged otherwise, streaming the response straight through
 * It only ever talks to GATEWAY_URL. Bodies and keys are never logged.
 */
const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT || 4020);
const GATEWAY_URL = (process.env.GATEWAY_URL || '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
const PREFIX = process.env.MODEL_PREFIX || 'baseline-eus2/';
const EXTRA_MAP = (() => { try { return JSON.parse(process.env.MODEL_MAP || '{}'); } catch { return {}; } })();

const FAMILY = [
  [/^claude-opus/i, 'claude-opus-5'],
  [/^claude-sonnet/i, 'claude-sonnet-5'],
  [/^claude-haiku/i, 'claude-haiku-4-5'],
  [/^claude-fable/i, 'claude-fable-5-1'],
];

/** Map an app-side model name to a gateway model name. Already-prefixed names pass through. */
const mapModel = (m) => {
  if (typeof m !== 'string' || !m) return m;
  if (EXTRA_MAP[m]) return EXTRA_MAP[m];
  if (m.includes('/')) return m;
  for (const [re, target] of FAMILY) if (re.test(m)) return PREFIX + target;
  return m;
};

if (!GATEWAY_URL) console.warn('[shim] GATEWAY_URL is not set — every request will get 503');
if (!GATEWAY_KEY) console.warn('[shim] GATEWAY_KEY is empty — every request will get 503 until it is set');

let upstream;
try { upstream = new URL(GATEWAY_URL || 'http://invalid.local'); } catch { upstream = null; }
const client = upstream && upstream.protocol === 'http:' ? http : https;

http.createServer((req, res) => {
  if (req.url === '/__shim/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!GATEWAY_URL || !GATEWAY_KEY || !upstream) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'anthropic-shim is not configured (GATEWAY_URL / GATEWAY_KEY missing)' } }));
    }
    let body = Buffer.concat(chunks);
    let note = '';
    if (body.length && /json/i.test(req.headers['content-type'] || '')) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        if (j && typeof j.model === 'string') {
          const mapped = mapModel(j.model);
          if (mapped !== j.model) { note = ` model ${j.model} -> ${mapped}`; j.model = mapped; body = Buffer.from(JSON.stringify(j)); }
          else note = ` model ${j.model}`;
        }
      } catch { /* not JSON: forward untouched */ }
    }

    const headers = { ...req.headers };
    for (const h of ['host', 'connection', 'content-length', 'authorization', 'x-api-key', 'accept-encoding']) delete headers[h];
    headers['x-api-key'] = GATEWAY_KEY;
    headers['authorization'] = `Bearer ${GATEWAY_KEY}`;
    headers['content-length'] = String(body.length);

    const started = Date.now();
    const out = client.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
      method: req.method, path: (upstream.pathname.replace(/\/+$/, '') + req.url), headers,
    }, (up) => {
      const h = { ...up.headers }; delete h['transfer-encoding'];
      res.writeHead(up.statusCode || 502, h);
      up.pipe(res);
      up.on('end', () => console.log(`[shim] ${req.method} ${req.url}${note} -> ${up.statusCode} (${Date.now() - started}ms)`));
    });
    out.setTimeout(600000, () => out.destroy(new Error('upstream timeout')));
    out.on('error', (e) => {
      console.error(`[shim] ${req.method} ${req.url}${note} -> upstream error: ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `shim upstream error: ${e.message}` } }));
    });
    out.end(body);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`[shim] listening on :${PORT} -> ${GATEWAY_URL ? upstream.host : '(unset)'} (prefix ${PREFIX})`));
