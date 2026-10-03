'use strict';
// C.3: service configuration (master plan I-4) and token registry (I-5).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const { normalizeConfig, loadConfig, deriveIndexerWs } = require('../../src/config');
const { parseTokenRegistry, loadTokenRegistry } = require('../../src/tokens/registry');

const wallet = Keypair.generate().publicKey.toBase58();
const T0 = '0'.repeat(64);
const staticTokens = [{ name: 'Night', symbol: 'NIGHT', balances: { [wallet]: '1' } }];
const midnight = {
  networkId: 'undeployed',
  indexerHttp: 'http://127.0.0.1:18088/api/v4/graphql',
  indexerWs: 'ws://127.0.0.1:18088/api/v4/graphql/ws',
  decryptorBin: './decryptor/target/release/midnight-esk-decrypt',
  tokenRegistry: './tokens/tokens.undeployed.json',
};
const REPO = path.join(__dirname, '..', '..');

test('phase-1 config is unchanged: tokens required without midnight', () => {
  const c = normalizeConfig({ upstream: 'http://127.0.0.1:1', tokens: staticTokens });
  assert.equal(c.port, 8899);
  assert.equal(c.wsPort, 8900);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.publicUrl, 'http://127.0.0.1:8899');
  assert.equal(c.upstreamWs, 'ws://127.0.0.1:2/');
  assert.equal(c.midnight, null);
  assert.equal(c.tokens.length, 1);
  assert.throws(() => normalizeConfig({ upstream: 'http://x' }), /config.tokens must list at least one token/);
  assert.throws(() => normalizeConfig({ tokens: staticTokens }), /config.upstream is required/);
});

test('tokens are optional when midnight is set; paths resolve against the config dir', () => {
  const c = normalizeConfig({ upstream: 'http://127.0.0.1:1', midnight }, { baseDir: REPO });
  assert.deepEqual(c.tokens, []);
  assert.equal(c.midnight.networkId, 'undeployed');
  assert.equal(c.midnight.decryptorBin, path.join(REPO, 'decryptor/target/release/midnight-esk-decrypt'));
  assert.equal(c.midnight.tokenRegistry, path.join(REPO, 'tokens/tokens.undeployed.json'));
  assert.equal(c.dataDir, path.join(REPO, 'data'));
  assert.equal(c.midnight.reconnectMinMs, 1000);
  assert.equal(c.midnight.reconnectMaxMs, 30000);
  assert.equal(c.midnight.syncMinMs, 10000, 'sync rule: progress must arrive >= 10 s after subscribing');
  assert.equal(c.midnight.syncQuietMs, 5000, 'sync rule: no relevant tx in the last 5 s');
  assert.equal(c.midnight.registry.tokens.get(T0).symbol, 'MNTT');
});

test('every I-4 environment override wins over the file', () => {
  const env = {
    HOST: '0.0.0.0',
    PORT: '12345',
    PUBLIC_URL: 'https://rpc.example.com/',
    UPSTREAM: 'http://10.0.0.1:8899',
    UPSTREAM_WS: 'ws://10.0.0.1:8900',
    DATA_DIR: 'state',
    MIDNIGHT_NETWORK_ID: 'undeployed',
    MIDNIGHT_INDEXER_HTTP: 'http://indexer:8088/api/v4/graphql',
    MIDNIGHT_INDEXER_WS: 'ws://indexer:8088/api/v4/graphql/ws',
    DECRYPTOR_BIN: '/usr/local/bin/midnight-esk-decrypt',
    TOKEN_REGISTRY: path.join(REPO, 'tokens/tokens.undeployed.json'),
    LOG: 'verbose',
  };
  const c = normalizeConfig({ upstream: 'http://127.0.0.1:1', port: 1, tokens: staticTokens, midnight: { ...midnight, networkId: 'other' } }, { env, cwd: '/srv' });
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.port, 12345);
  assert.equal(c.wsPort, 12346);
  assert.equal(c.publicUrl, 'https://rpc.example.com');
  assert.equal(c.upstream, 'http://10.0.0.1:8899');
  assert.equal(c.upstreamWs, 'ws://10.0.0.1:8900');
  assert.equal(c.dataDir, '/srv/state', 'env paths resolve against the working directory');
  assert.equal(c.midnight.networkId, 'undeployed');
  assert.equal(c.midnight.indexerHttp, 'http://indexer:8088/api/v4/graphql');
  assert.equal(c.midnight.indexerWs, 'ws://indexer:8088/api/v4/graphql/ws');
  assert.equal(c.midnight.decryptorBin, '/usr/local/bin/midnight-esk-decrypt');
  assert.equal(c.log, 'verbose');
  assert.equal(normalizeConfig({ upstream: 'http://x', tokens: staticTokens }, { env: { LOG: 'false' } }).log, false);
});

test('midnight can come from the environment alone; indexerWs is derived when missing', () => {
  const env = { MIDNIGHT_NETWORK_ID: 'undeployed', MIDNIGHT_INDEXER_HTTP: 'http://127.0.0.1:9/api/v4/graphql', DECRYPTOR_BIN: 'bin/dec' };
  const c = normalizeConfig({ upstream: 'http://x' }, { env, cwd: '/w' });
  assert.equal(c.midnight.indexerWs, 'ws://127.0.0.1:9/api/v4/graphql/ws');
  assert.equal(c.midnight.decryptorBin, '/w/bin/dec');
  assert.equal(c.midnight.tokenRegistry, path.join(REPO, 'tokens/tokens.undeployed.json'), 'bundled registry for the network');
  assert.equal(deriveIndexerWs('https://h/api/v4/graphql/'), 'wss://h/api/v4/graphql/ws');
});

test('invalid midnight settings are rejected with a message', () => {
  const bad = (m, re) => assert.throws(() => normalizeConfig({ upstream: 'http://x', midnight: { ...midnight, ...m } }, { baseDir: REPO }), re);
  bad({ networkId: undefined }, /networkId is required/);
  bad({ networkId: 'Bad_Net' }, /lowercase/);
  bad({ indexerHttp: undefined }, /indexerHttp is required/);
  bad({ indexerHttp: 'ftp://x' }, /must use http/);
  bad({ indexerWs: 'http://x' }, /must use ws/);
  bad({ decryptorBin: undefined }, /decryptorBin is required/);
  bad({ tokenRegistry: './nope.json' }, /cannot read token registry/);
  bad({ reconnectMinMs: 5000, reconnectMaxMs: 10 }, /reconnectMaxMs/);
  assert.throws(() => normalizeConfig({ upstream: 'http://x', midnight: [] }), /must be an object/);
});

test('token registry: valid file, defaults left to the caller, strict validation', () => {
  const r = parseTokenRegistry({ network: 'undeployed', tokens: { [T0.toUpperCase()]: { name: 'A', symbol: 'B', decimals: 8, image: 'https://i' } } }, { networkId: 'undeployed' });
  assert.deepEqual(r.tokens.get(T0), { name: 'A', symbol: 'B', decimals: 8, image: 'https://i' }, 'keys normalized to lowercase');
  const bad = (raw, re) => assert.throws(() => parseTokenRegistry(raw, { networkId: 'undeployed' }), re);
  bad({ network: 'preprod', tokens: {} }, /"network" is "preprod"/);
  bad({ network: 'undeployed' }, /"tokens" must be an object/);
  bad({ network: 'undeployed', tokens: { abc: {} } }, /64-hex token type/);
  bad({ network: 'undeployed', tokens: { [T0]: { name: 'x'.repeat(33) } } }, /name must be 1..32 bytes/);
  bad({ network: 'undeployed', tokens: { [T0]: { symbol: 'TOOLONGSYMBOL' } } }, /symbol must be 1..10 bytes/);
  bad({ network: 'undeployed', tokens: { [T0]: { decimals: 1.5 } } }, /decimals must be an integer/);
  bad({ network: 'undeployed', tokens: { [T0]: { uri: 'x'.repeat(201) } } }, /uri must be at most 200 bytes/);
});

test('bundled tokens/tokens.undeployed.json names the three genesis types', () => {
  const r = loadTokenRegistry(path.join(REPO, 'tokens/tokens.undeployed.json'), { networkId: 'undeployed' });
  assert.deepEqual(
    [...r.tokens].map(([k, v]) => [k.slice(-1), v.name, v.symbol, v.decimals]),
    [
      ['0', 'Midnight Test Token', 'MNTT', 6],
      ['1', 'Midnight Alt Token 1', 'MNA1', 6],
      ['2', 'Midnight Alt Token 2', 'MNA2', 6],
    ],
  );
});

test('loadConfig reads a file and applies the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sti-cfg-'));
  try {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ upstream: 'http://127.0.0.1:1', tokens: staticTokens, dataDir: 'd' }));
    const c = loadConfig(f, { env: { PORT: '20001' } });
    assert.equal(c.port, 20001);
    assert.equal(c.dataDir, path.join(dir, 'd'));
    fs.writeFileSync(f, '{');
    assert.throws(() => loadConfig(f, { env: {} }), /is not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
