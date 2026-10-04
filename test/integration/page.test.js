'use strict';
// C.9 / gate C2: GET / serves the page with the form, the table, the banner
// and this service's RPC URL; at 375 px it uses the stacked layout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startStack } = require('../helpers/stack');

test('GET / serves the registration page', async (t) => {
  const stack = await startStack();
  t.after(() => stack.stop());
  const r = await fetch(`${stack.svc.url}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  const html = await r.text();
  if (process.env.SAVE_PAGE) fs.writeFileSync(process.env.SAVE_PAGE, html);
  assert.match(html, /<title>Midnight Token Injector<\/title>/);
  assert.match(html, /v1 — not private:<\/strong> the service stores viewing keys and shows what they reveal\. Amounts are totals RECEIVED: a viewing key cannot see spends\./);
  assert.match(html, /<form id="form"/);
  assert.match(html, /id="solanaAddress"/);
  assert.match(html, /id="viewingKey"/);
  assert.match(html, /<button type="submit"/);
  assert.match(html, /id="form-msg" role="alert"/, 'inline error area');
  assert.match(html, /<table id="registrations">/);
  for (const h of ['Solana address', 'Viewing key', 'Status', 'Tokens (received)', 'Created']) assert.ok(html.includes(`<th>${h}</th>`), h);
  assert.ok(html.includes(`<code id="rpc-url">${stack.svc.url}</code>`), 'RPC URL to paste into the wallet');
  assert.ok(html.includes('placeholder="mn_shield-esk_undeployed1…"'), 'key prefix for this network');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'all placeholders filled');
  assert.match(html, /setInterval\(refresh, REFRESH_MS\)/);
  assert.match(html, /var REFRESH_MS = 3000;/, 'auto-refresh every 3 s');
  assert.match(html, /@media \(prefers-color-scheme: dark\)/, 'dark mode');
  assert.match(html, /@media \(max-width: 720px\)/, 'narrow layout (375 px)');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(!/innerHTML/.test(html), 'dynamic values are inserted as text, never as HTML');
});
