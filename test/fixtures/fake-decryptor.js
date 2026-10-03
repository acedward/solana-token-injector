#!/usr/bin/env node
'use strict';
// Test double for `midnight-esk-decrypt` (master plan I-1). It does no
// cryptography: answers come from a JSON map file named by the env var
// FAKE_DECRYPTOR_MAP, re-read on every request so tests can add transactions
// while the service runs (write it atomically: temp file + rename).
//
// Map file:
//   { "<raw hex>": [ {segment, outputIndex, commitment, tokenType, value, viewingKey?}, ... ],
//     "<raw hex>": { "error": "undecodable transaction" },
//     "__rejectKeys": ["<viewing key>", ...],     // validateKey says no
//     "__hangRaws": ["<raw hex>", ...],            // never answer (timeout tests)
//     "__delayMs": 0 }                             // delay every answer
// A coin with `viewingKey` is reported only to that key (several keys can see
// one transaction, e.g. a payment and its change).
//
// Test-only op: {"op": "__exit", "code": N} exits immediately.
// Like the real binary: answers in request order, never logs keys.

const fs = require('fs');
const readline = require('readline');

const MAP = process.env.FAKE_DECRYPTOR_MAP;

function readMap() {
  if (!MAP) return {};
  try {
    return JSON.parse(fs.readFileSync(MAP, 'utf8'));
  } catch {
    return {};
  }
}

const hrp = (networkId) => (networkId === 'mainnet' ? 'mn_shield-esk' : `mn_shield-esk_${networkId}`);

function handle(req, map) {
  switch (req.op) {
    case 'version':
      return { ok: true, version: '0.0.0-fake', ledger: 'fake' };
    case 'validateKey': {
      if (typeof req.viewingKey !== 'string' || !req.viewingKey.startsWith(`${hrp(req.networkId)}1`)) {
        return { ok: false, error: 'invalid viewing key: hrp mismatch' };
      }
      if ((map.__rejectKeys || []).includes(req.viewingKey)) return { ok: false, error: 'invalid viewing key: not a field element' };
      return { ok: true };
    }
    case 'decrypt': {
      if (typeof req.viewingKey !== 'string' || !req.viewingKey.startsWith(`${hrp(req.networkId)}1`)) {
        return { ok: false, error: 'invalid viewing key: hrp mismatch' };
      }
      const entry = map[req.raw];
      if (entry === undefined) return { ok: false, error: 'undecodable transaction (fake: unknown raw)' };
      if (!Array.isArray(entry)) return { ok: false, error: entry.error || 'undecodable transaction' };
      const coins = entry
        .filter((c) => !c.viewingKey || c.viewingKey === req.viewingKey)
        .map(({ viewingKey, ...c }) => c); // eslint-disable-line no-unused-vars
      return { ok: true, coins };
    }
    default:
      return { ok: false, error: `unknown op "${req.op}"` };
  }
}

let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  chain = chain.then(async () => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ id: null, ok: false, error: 'malformed request line' })}\n`);
      return;
    }
    if (req.op === '__exit') process.exit(Number(req.code) || 0);
    const map = readMap();
    if (req.op === 'decrypt' && (map.__hangRaws || []).includes(req.raw)) return; // never answer
    if (map.__delayMs) await new Promise((r) => setTimeout(r, map.__delayMs));
    process.stdout.write(`${JSON.stringify({ id: req.id, ...handle(req, map) })}\n`);
  });
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
