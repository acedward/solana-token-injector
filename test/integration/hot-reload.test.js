'use strict';
// C.2 / gate C3 (US4): edits to config.json apply without a restart; an
// invalid edit keeps the previous config and logs the error.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Keypair } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { startMockUpstream } = require('../helpers/mock-upstream');
const { startService, waitFor } = require('../helpers/service');

const wallet = Keypair.generate().publicKey.toBase58();

async function nightAmount(svc) {
  const r = await svc.rpc('getTokenAccountsByOwner', [wallet, { programId: spl.TOKEN_PROGRAM_ID.toBase58() }, { encoding: 'jsonParsed' }]);
  const acct = r.result.value.find((a) => a.account.data.parsed.info.tokenAmount);
  return acct ? acct.account.data.parsed.info.tokenAmount.uiAmountString : null;
}

test('config.json hot reload (US4)', async (t) => {
  const up = await startMockUpstream();
  const base = (amount, extra = {}) => ({
    upstream: up.url,
    tokens: [{ name: 'Night', symbol: 'NIGHT', decimals: 6, balances: { [wallet]: amount }, ...extra }],
  });
  const svc = await startService({ config: base('10') });
  t.after(async () => {
    await svc.stop();
    await up.close();
  });
  const rewrite = (cfg) => fs.writeFileSync(svc.configPath, JSON.stringify({ ...cfg, port: svc.port, log: false }));

  await t.test('initial amount', async () => {
    assert.equal(await nightAmount(svc), '10');
  });

  await t.test('a balance edit is picked up without a restart', async () => {
    rewrite(base('25.5'));
    await waitFor(async () => (await nightAmount(svc)) === '25.5', { what: 'new balance', timeoutMs: 5000 });
  });

  await t.test('invalid JSON keeps the previous config and logs the error', async () => {
    fs.writeFileSync(svc.configPath, '{ "upstream": ');
    await waitFor(() => svc.output().includes('config reload failed'), { what: 'reload error log' });
    assert.equal(await nightAmount(svc), '25.5');
  });

  await t.test('an invalid token keeps the previous config', async () => {
    const before = svc.output().split('config reload failed').length;
    rewrite({ upstream: up.url, tokens: [{ name: 'Night', symbol: 'NIGHT', balances: { 'not-an-address': '1' } }] });
    await waitFor(() => svc.output().split('config reload failed').length > before, { what: 'second reload error' });
    assert.match(svc.output(), /"not-an-address" is not a valid wallet address/);
    assert.equal(await nightAmount(svc), '25.5');
  });

  await t.test('a valid edit after errors applies again (added token too)', async () => {
    rewrite({
      upstream: up.url,
      tokens: [
        { name: 'Night', symbol: 'NIGHT', decimals: 6, balances: { [wallet]: '1' } },
        { name: 'Dust', symbol: 'DUST', decimals: 9, program: 'token-2022', balances: { [wallet]: '2' } },
      ],
    });
    await waitFor(async () => (await nightAmount(svc)) === '1', { what: 'reapplied config' });
    const r = await svc.rpc('getTokenAccountsByOwner', [wallet, { programId: spl.TOKEN_2022_PROGRAM_ID.toBase58() }, { encoding: 'jsonParsed' }]);
    assert.equal(r.result.value.length, 1);
    assert.equal(r.result.value[0].account.data.parsed.info.tokenAmount.uiAmountString, '2');
  });
});
