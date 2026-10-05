'use strict';
// AA 00059 P2 (T2.1): the service's account watcher replays G-BALANCE's recorded localnet checkpoints
// C1-C6 (test/fixtures/nm-localnet/c*.json: the indexer's answers on Night Market's localnet and the
// opened coin plaintexts by inbox index, no secret) through the mock indexer, and its per-colour totals
// equal the page's recorded holdings: exactly, except at C4 for A, where the page also counts the
// withdrawal's change it holds locally (documented: unseenCoins 1 until Night Market files it).
// The inbox opener is stubbed with the recorded plaintexts; T2.2 covers the real opener.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadNightMarket } = require('../../src/accounts/bundle');
const { createIndexerReader } = require('../../src/accounts/chain');
const { AccountWatcher } = require('../../src/accounts/watcher');
const { startMockIndexer } = require('../helpers/mock-indexer');

const FIX = path.join(__dirname, '..', 'fixtures', 'nm-localnet');
const CHECKPOINTS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const low = (h) => String(h).replace(/^0x/, '').toLowerCase();

let nm;
test.before(async () => {
  nm = await loadNightMarket();
});

const answer = (record, re) => record.graphql.find((p) => re.test(p.request.query)).response.data;

async function replay(record) {
  const st = answer(record, /query AccountState\(/);
  const page = answer(record, /query AccountHistory\(/);
  const tip = answer(record, /query AccountHistoryTip/).block.height;
  const idx = await startMockIndexer();
  idx.setContract(record.account, { state: st.contract.state, actions: [...page.contract.actions].reverse(), deployHeight: 1 });
  idx.setTip(tip);
  const decoded = nm.decodeAccountState(record.account, st.contract.state);
  // The recorded plaintexts, by the ciphertext at their inbox index.
  const byEntry = new Map(record.opened.map((c) => [low(decoded.inbox[Number(c.inboxIndex)]), c]));
  const openEntry = async (entry) => {
    const c = byEntry.get(Buffer.from(entry).toString('hex'));
    return c ? { nonce: Buffer.from(c.nonce, 'hex'), color: Buffer.from(c.color, 'hex'), value: BigInt(c.value) } : null;
  };
  const chain = createIndexerReader({ indexerHttp: idx.httpUrl, indexerWs: idx.wsUrl, nm, timeoutMs: 3000 });
  const w = new AccountWatcher({ address: record.account, keys: [{ secret: '00'.repeat(32), publicKey: decoded.view.encKey }], nm, chain, pollMs: 60_000, openEntry });
  await w.pollNow();
  const snap = w.snapshot();
  await w.stop();
  await idx.close();
  return snap;
}

for (const cp of CHECKPOINTS) {
  test(`T2.1 replay ${cp}: the service's totals equal the page's recorded holdings`, async () => {
    const f = require(path.join(FIX, `${cp}.json`));
    for (const who of ['A', 'B']) {
      const { record, page } = f[who];
      const s = await replay(record);
      assert.equal(s.status, 'synced', `${cp} ${who}: ${s.error}`);
      const service = Object.fromEntries([...s.amounts.shielded].map(([c, v]) => [c, v.toString(10)]));
      const pageTotals = Object.fromEntries(page.holdings.map((h) => [h.colour, h.total]));
      // The tool's own result on the localnet, recorded with the pairs: the same code, the same answer.
      assert.deepEqual(service, Object.fromEntries(record.result.holdings.map((h) => [h.colour, h.total])), `${cp} ${who} vs the tool`);
      assert.equal(s.unseenCoins, record.result.unseenCoins);
      assert.equal(s.unconfirmedNotes, record.result.unconfirmedNotes);
      if (cp === 'c4' && who === 'A') {
        const change = page.coins.find((c) => c.origin === 'change' && !c.inInbox && !c.spent);
        assert.ok(change, 'the page holds the change locally');
        const expected = { ...pageTotals, [change.colour]: (BigInt(pageTotals[change.colour]) - BigInt(change.value)).toString(10) };
        if (expected[change.colour] === '0') delete expected[change.colour];
        assert.deepEqual(service, expected, 'C4 A: the page minus the unfiled change');
        assert.equal(s.unseenCoins, 1);
      } else {
        assert.deepEqual(service, pageTotals, `${cp} ${who}`);
      }
      assert.deepEqual(Object.fromEntries([...s.amounts.unshielded].map(([c, v]) => [c, v.toString(10)])), Object.fromEntries(page.unshielded.map((u) => [u.colour, u.amount])));
    }
  });
}
