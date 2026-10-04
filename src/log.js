'use strict';
// Logging. One line per RPC method (`pass`, `patched`, `local`); `log: "verbose"`
// adds params, callers and upstream errors. Viewing keys are never printed in
// full: everything that might carry one goes through `maskKey` / `redact`.

const JSONbig = require('json-bigint')({ useNativeBigInt: true });

const state = { enabled: true, verbose: false };

/** `log` config value: `false` (quiet), `true` (default) or `"verbose"`. */
function configure(logSetting) {
  state.enabled = logSetting !== false;
  state.verbose = logSetting === 'verbose';
}

const isVerbose = () => state.verbose;
const isEnabled = () => state.enabled;
const stamp = () => new Date().toISOString().slice(11, 23);

function line(text) {
  if (state.enabled) console.log(`${stamp()}  ${redact(text)}`);
}

/** Problems worth seeing even with `log: false` (stderr). */
function warn(text) {
  console.error(`${stamp()}  ${redact(text)}`);
}

/** One line per JSON-RPC request: `<time>  <how> <method>` (+ params when verbose). */
function method(req, how) {
  if (!state.enabled) return;
  let out = `${stamp()}  ${how.padEnd(9)} ${req && req.method}`;
  if (state.verbose && req && req.params !== undefined) {
    const p = JSONbig.stringify(req.params);
    out += `  ${p.length > 300 ? `${p.slice(0, 300)}…` : p}`;
  }
  console.log(out);
}

// Verbose mode: who is calling (first time per origin + user agent), and every
// preflight, GET and websocket message, since a blocked preflight never reaches POST.
const seenClients = new Set();
function client(kind, req) {
  if (!state.verbose) return;
  const origin = req.headers.origin || '-';
  const ua = (req.headers['user-agent'] || '-').slice(0, 80);
  const ip = req.headers['cf-connecting-ip'] || 'local'; // set when the request came through a Cloudflare tunnel
  if (kind === 'POST') {
    const key = `${origin}|${ua}|${ip}`;
    if (seenClients.has(key)) return;
    seenClients.add(key);
  }
  let out = `client    ${kind} ${req.url}  ip=${ip}  origin=${origin}  ua=${ua}`;
  if (kind === 'OPTIONS') {
    const h = (n) => req.headers[n] || '-';
    out += `  acr-method=${h('access-control-request-method')} acr-headers=${h('access-control-request-headers')} acr-private-network=${h('access-control-request-private-network')}`;
  }
  line(out);
}

/** First 16 + `…` + last 6 characters (Q10). Short strings are fully hidden. */
function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 22) return '…';
  return `${s.slice(0, 16)}…${s.slice(-6)}`;
}

// Any bech32 Midnight secret key that slips into a log line is masked.
const SECRET_KEY_RE = /mn_shield-esk(?:_[a-z0-9-]+)?1[02-9ac-hj-np-z]{6,}/gi;
function redact(text) {
  return String(text).replace(SECRET_KEY_RE, (k) => maskKey(k));
}

module.exports = { configure, isVerbose, isEnabled, line, warn, method, client, maskKey, redact };
