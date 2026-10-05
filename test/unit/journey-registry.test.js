'use strict';
// AA 00059 P4 (T4.1 and the upstream checks in-process): the journey token registry (00057 I-1).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');

const j = require('../../src/tokens/journey-registry');

const GENESIS = 'GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC';
const mintA = Keypair.generate().publicKey.toBase58();
const mintB = Keypair.generate().publicKey.toBase58();
const C1 = '11'.repeat(32);
const C2 = '22'.repeat(32);
const entry = (o = {}) => ({ colour: C1, splMint: mintA, bridgeContract: 'ab'.repeat(32), bridgeProgram: Keypair.generate().publicKey.toBase58(), bridgeApi: 'http://127.0.0.1:1', name: 'Test X', symbol: 'X', decimals: 6, ...o });
const file = (tokens, o = {}) => ({ midnightNetwork: 'undeployed', solanaGenesisHash: GENESIS, tokens, ...o });

test('T4.1 parse: duplicates, bad formats, another network -> refused with the field named; extra fields accepted', () => {
  const ok = j.parseJourneyRegistry(file([entry(), entry({ colour: C2, splMint: mintB, name: 'Test Y', symbol: 'Y', extra: { any: 1 } })]), { networkId: 'undeployed' });
  assert.equal(ok.tokens.size, 2);
  assert.deepEqual(Object.keys(ok.tokens.get(C1)).sort(), ['bridgeContract', 'colour', 'decimals', 'name', 'splMint', 'symbol']);
  const refused = [
    [file([entry(), entry({ splMint: mintB })]), /tokens\[1\]\.colour .* listed twice/],
    [file([entry(), entry({ colour: C2 })]), /tokens\[1\]\.splMint .* listed twice/],
    [file([entry({ colour: 'AB'.repeat(32) })]), /tokens\[0\]\.colour must be 64 lowercase hex/],
    [file([entry({ colour: C1.slice(2) })]), /tokens\[0\]\.colour/],
    [file([entry({ splMint: `1${mintA}` })]), /tokens\[0\]\.splMint must be a canonical base58/],
    [file([entry({ splMint: 'not-base58!' })]), /tokens\[0\]\.splMint/],
    [file([entry({ bridgeContract: 'zz' })]), /tokens\[0\]\.bridgeContract/],
    [file([entry({ decimals: 1.5 })]), /tokens\[0\]\.decimals/],
    [file([entry({ name: ' ' })]), /tokens\[0\]\.name/],
    [file([entry()], { midnightNetwork: 'stagenet' }), /"midnightNetwork" is "stagenet" but the service runs on Midnight network "undeployed"/],
    [file([entry()], { solanaGenesisHash: 'nope' }), /solanaGenesisHash/],
    [{ network: 'undeployed', tokens: {} }, /injector's own token registry/],
    [[], /must be a JSON object/],
  ];
  for (const [raw, re] of refused) assert.throws(() => j.parseJourneyRegistry(raw, { networkId: 'undeployed' }), re);
});

function fakeUpstream({ genesis = GENESIS, mints = {}, failFirst = 0 } = {}) {
  let n = 0;
  return {
    calls: () => n,
    async post(text) {
      n++;
      if (n <= failFirst) throw new Error('ECONNREFUSED');
      const { method, params } = JSON.parse(text);
      if (method === 'getGenesisHash') return { status: 200, text: JSON.stringify({ result: genesis }) };
      const m = mints[params[0]];
      const value = m ? { owner: m.owner || j.TOKEN_PROGRAM, data: { parsed: { type: m.type || 'mint', info: { decimals: m.decimals } } } } : null;
      return { status: 200, text: JSON.stringify({ result: { context: { slot: 1 }, value } }) };
    },
  };
}

test('upstream checks: genesis, missing mint, Token-2022 mint, other decimals; retries while unreachable, then gives up', async () => {
  const reg = j.parseJourneyRegistry(file([entry()]), { networkId: 'undeployed' });
  const fast = { sleep: () => Promise.resolve() };
  assert.equal(await j.checkJourneyRegistry(reg, fakeUpstream({ mints: { [mintA]: { decimals: 6 } } }), fast), reg);
  await assert.rejects(j.checkJourneyRegistry(reg, fakeUpstream({ genesis: Keypair.generate().publicKey.toBase58(), mints: { [mintA]: { decimals: 6 } } }), fast), /upstream's genesis hash is/);
  await assert.rejects(j.checkJourneyRegistry(reg, fakeUpstream(), fast), /does not exist on the upstream/);
  await assert.rejects(j.checkJourneyRegistry(reg, fakeUpstream({ mints: { [mintA]: { decimals: 6, owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' } } }), fast), /not the classic SPL Token program/);
  await assert.rejects(j.checkJourneyRegistry(reg, fakeUpstream({ mints: { [mintA]: { decimals: 9 } } }), fast), /has 9 decimals on the upstream, the registry says 6/);
  // Unreachable for a while: retried, then it passes.
  const flaky = fakeUpstream({ mints: { [mintA]: { decimals: 6 } }, failFirst: 3 });
  assert.equal(await j.checkJourneyRegistry(reg, flaky, { retryMs: 10, deadlineMs: 5000 }), reg);
  // Unreachable past the deadline: refused.
  const t0 = Date.now();
  await assert.rejects(j.checkJourneyRegistry(reg, fakeUpstream({ failFirst: 1e9 }), { retryMs: 50, deadlineMs: 400 }), /did not answer for 0 s|did not answer/);
  assert.ok(Date.now() - t0 >= 300);
});

test('lookup: I-1 (I-4b) over the token registry for name, symbol, decimals; image and uri stay the registry\'s', () => {
  const reg = j.parseJourneyRegistry(file([entry({ decimals: 9 })]), { networkId: 'undeployed' });
  const registry = (k) => (k === C1 ? { name: 'Old', symbol: 'OLD', decimals: 6, image: 'https://img', uri: 'https://uri' } : k === C2 ? { name: 'Kept', symbol: 'K', decimals: 2 } : null);
  const lookup = j.combineLookups(j.journeyLookup(reg), registry);
  assert.deepEqual(lookup(C1), { name: 'Test X (Midnight)', symbol: 'mnX', decimals: 9, image: 'https://img', uri: 'https://uri', description: `Midnight half of Test X (SPL mint ${mintA}), bridged by contract abababababababab; display only` });
  assert.deepEqual(lookup(C2), { name: 'Kept', symbol: 'K', decimals: 2 });
  assert.equal(lookup(`u:${C1}`), null);
  assert.equal(lookup('33'.repeat(32)), null);
});

test('P7.2 I-1 images: optional https URLs of at most 200 bytes; the registry image wins, the I-1 image fills a gap; fill-ins carry splImage', () => {
  const img = 'https://midnight-solana-token-icons.ac-edward.workers.dev/x-midnight.png';
  const spl = 'https://midnight-solana-token-icons.ac-edward.workers.dev/x.png';
  const reg = j.parseJourneyRegistry(file([entry({ image: img, splImage: spl })]), { networkId: 'undeployed' });
  assert.equal(reg.tokens.get(C1).image, img);
  assert.equal(reg.tokens.get(C1).splImage, spl);
  for (const [field, v] of [['image', 'http://x/a.png'], ['image', `https://x/${'a'.repeat(200)}.png`], ['splImage', 42], ['splImage', 'https://x/a b.png'], ['image', '']]) {
    assert.throws(() => j.parseJourneyRegistry(file([entry({ [field]: v })]), { networkId: 'undeployed' }), new RegExp(`tokens\\[0\\]\\.${field} must be an https URL`));
  }
  const noImageRegistry = (k) => (k === C1 ? { name: 'Old', symbol: 'OLD', decimals: 6 } : null);
  const withImageRegistry = (k) => (k === C1 ? { name: 'Old', symbol: 'OLD', decimals: 6, image: 'https://registry/x.png' } : null);
  assert.equal(j.combineLookups(j.journeyLookup(reg), noImageRegistry)(C1).image, img);
  assert.equal(j.combineLookups(j.journeyLookup(reg), withImageRegistry)(C1).image, 'https://registry/x.png');
  assert.equal(j.combineLookups(j.journeyLookup(reg), () => null)(C1).image, img);
  assert.deepEqual(j.journeyFillIns(reg), [{ mint: mintA, name: 'Test X', symbol: 'X', image: spl }]);
  const bare = j.parseJourneyRegistry(file([entry()]), { networkId: 'undeployed' });
  assert.deepEqual(j.journeyFillIns(bare), [{ mint: mintA, name: 'Test X', symbol: 'X' }]);
  assert.equal('image' in j.combineLookups(j.journeyLookup(bare), noImageRegistry)(C1), false);
  assert.deepEqual(j.journeyFillIns(null), []);
});
