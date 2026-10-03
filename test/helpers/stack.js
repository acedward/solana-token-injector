'use strict';
// Full local test stack without Docker or a real network: mock Solana
// upstream + mock Midnight indexer (in this process) + the real service
// (child process) running the fake decryptor (grandchild).

const fs = require('fs');
const path = require('path');
const { startMockUpstream } = require('./mock-upstream');
const { startMockIndexer } = require('./mock-indexer');
const { createFakeMap, FAKE_DECRYPTOR } = require('./fake-map');
const { startService, makeTempDir, ROOT } = require('./service');

async function startStack({ networkId = 'undeployed', tokens, midnightExtra = {}, configExtra = {} } = {}) {
  const dir = makeTempDir('sti-stack-');
  const upstream = await startMockUpstream();
  const indexer = await startMockIndexer();
  const map = createFakeMap(path.join(dir, 'fake-decryptor-map.json'));
  const config = {
    upstream: upstream.url,
    dataDir: path.join(dir, 'data'),
    midnight: {
      networkId,
      indexerHttp: indexer.httpUrl,
      indexerWs: indexer.wsUrl,
      decryptorBin: FAKE_DECRYPTOR,
      tokenRegistry: path.join(ROOT, 'tokens', `tokens.${networkId}.json`),
      reconnectMinMs: 100,
      reconnectMaxMs: 400,
      decryptorTimeoutMs: 3000,
      ...midnightExtra,
    },
    ...(tokens ? { tokens } : {}),
    ...configExtra,
  };
  if (!fs.existsSync(config.midnight.tokenRegistry)) delete config.midnight.tokenRegistry;
  const env = { FAKE_DECRYPTOR_MAP: map.file };
  let svc = await startService({ config, dir, env });

  let rawSeq = 0;
  const stack = {
    dir,
    upstream,
    indexer,
    map,
    config,
    get svc() {
      return svc;
    },
    /** Adds a relevant transaction for `viewingKey` (fake decryptor map + indexer). */
    tx(viewingKey, coins, { status = 'SUCCESS', segments = null } = {}) {
      const raw = `cafe${(++rawSeq).toString(16).padStart(8, '0')}`;
      map.set(raw, coins);
      return indexer.addTransaction(viewingKey, { raw, status, segments });
    },
    register: (solanaAddress, viewingKey) => svc.api('POST', '/api/registrations', { solanaAddress, viewingKey }),
    list: async () => (await svc.api('GET', '/api/registrations')).json,
    /** Restarts the service process with the same config and data dir. */
    async restart() {
      await svc.kill();
      svc = await startService({ config: { ...config, port: svc.port }, dir, env });
      return svc;
    },
    async stop() {
      await svc.kill();
      await indexer.close();
      await upstream.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return stack;
}

module.exports = { startStack };
