'use strict';
// C.7 wiring: registrations -> one watcher per viewing key -> TokenState.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { RegistryService } = require('../../src/registry/service');
const { DecryptorClient } = require('../../src/midnight/decryptor');
const { createTokenManager } = require('../../src/tokens/manager');
const { midnightTokenSpecs, midnightTokenId } = require('../../src/tokens/midnight');
const { loadTokenRegistry, registryLookup } = require('../../src/tokens/registry');
const { deriveKey } = require('../../src/tokens/accounts');
const { startMockIndexer } = require('../helpers/mock-indexer');
const { createFakeMap, FAKE_DECRYPTOR } = require('../helpers/fake-map');
const { testViewingKey } = require('../helpers/keys');
const { waitFor } = require('../helpers/service');

const T0 = '0'.repeat(64);
const hex = (n) => n.toString(16).padStart(64, '0');
const lookup = registryLookup(loadTokenRegistry(path.join(__dirname, '..', '..', 'tokens', 'tokens.undeployed.json'), { networkId: 'undeployed' }));
const ata = (owner, type = T0) =>
  spl.getAssociatedTokenAddressSync(deriveKey(`mint:${midnightTokenId('undeployed', type)}`), new PublicKey(owner), false, spl.TOKEN_2022_PROGRAM_ID).toBase58();

test('registry service: shared watcher per key, sums, delete releases, rebuild before answering', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-reg-'));
  const map = createFakeMap(path.join(dir, 'map.json'), { tx1: [{ segment: 0, outputIndex: 0, commitment: hex(1), tokenType: T0, value: '2500000' }] });
  const decryptor = new DecryptorClient({ bin: FAKE_DECRYPTOR, env: { ...process.env, FAKE_DECRYPTOR_MAP: map.file } }).start();
  const indexer = await startMockIndexer();
  const midnight = { networkId: 'undeployed', indexerHttp: indexer.httpUrl, indexerWs: indexer.wsUrl, reconnectMinMs: 50, reconnectMaxMs: 200 };
  let svc;
  const tokens = createTokenManager({
    publicUrl: 'http://x',
    midnightSpecs: () => (svc ? midnightTokenSpecs({ networkId: 'undeployed', registrations: svc.tokenInputs(), lookup }) : []),
    debounceMs: 20,
  });
  svc = new RegistryService({ midnight, dataDir: path.join(dir, 'data'), decryptor, onChange: tokens.invalidate, onChangeNow: tokens.rebuildNow, getLookup: () => lookup }).start();
  t.after(async () => {
    await svc.stop();
    tokens.stop();
    await decryptor.stop();
    await indexer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const key = testViewingKey();
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  indexer.addTransaction(key, { raw: 'tx1' });

  const r1 = await svc.register({ solanaAddress: a, viewingKey: key });
  assert.equal(r1.created, true);
  assert.equal((await svc.register({ solanaAddress: a, viewingKey: key })).created, false, 'same pair = one registration');
  await waitFor(() => svc.get(r1.record.id).status === 'synced', { what: 'synced' });
  await tokens.settled();
  assert.equal(tokens.getState().tokenAccounts.get(ata(a)).amount, 2500000n);

  // A second address with the SAME key: it sees the totals at once (rebuild before answering), one watcher.
  const r2 = await svc.register({ solanaAddress: b, viewingKey: key });
  assert.equal(svc.watchers.size, 1);
  assert.equal(svc.watchers.get(key).refs, 2);
  assert.equal(indexer.calls.connect, 1, 'one indexer session for the shared key');
  assert.equal(tokens.getState().tokenAccounts.get(ata(b)).amount, 2500000n);

  const v = svc.get(r1.record.id);
  assert.equal(v.viewingKeyMasked, `${key.slice(0, 16)}…${key.slice(-6)}`);
  assert.ok(!JSON.stringify(svc.list()).includes(key), 'API view never contains the full key');
  assert.deepEqual(v.tokens, [{ tokenType: T0, mint: deriveKey(`mint:${midnightTokenId('undeployed', T0)}`).toBase58(), name: 'Midnight Test Token', symbol: 'MNTT', decimals: 6, amount: '2500000', uiAmountString: '2.5', clamped: false }]);
  assert.deepEqual(svc.health(), { total: 2, connecting: 0, syncing: 0, synced: 2, error: 0, viewingKeys: 1 });

  // Delete: tokens gone immediately; watcher kept while another registration uses the key.
  assert.ok(svc.remove(r1.record.id));
  assert.equal(tokens.getState().tokenAccounts.get(ata(a)), undefined);
  assert.equal(svc.watchers.size, 1);
  assert.equal(svc.remove(r1.record.id), null);
  svc.remove(r2.record.id);
  assert.equal(svc.watchers.size, 0);
  assert.equal(tokens.getState().byOwner.size, 0);
  await waitFor(() => indexer.calls.disconnect.length === 1, { what: 'session disconnected' });

  // Invalid input: 400 and nothing stored.
  await assert.rejects(svc.register({ solanaAddress: 'x', viewingKey: key }), (e) => e.status === 400);
  await assert.rejects(svc.register({ solanaAddress: a, viewingKey: testViewingKey('preprod') }), (e) => e.status === 400);
  assert.equal(svc.list().length, 0);
});
