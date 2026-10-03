'use strict';
// End-to-end test: starts a mock upstream RPC, runs proxy.js in front of it,
// and checks the injected token through @solana/web3.js and @solana/spl-token.
// Run with: npm test

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const UP_PORT = 28799; // mock upstream (ws on 28800)
const PX_PORT = 28899; // proxy (ws on 28900)
const MPL = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const wallet = Keypair.generate().publicKey;
const otherWallet = Keypair.generate().publicKey;
const realMint = Keypair.generate().publicKey;
const realAccount = Keypair.generate().publicKey;

// ------------------------------------------------------------ mock upstream

const ctx = { slot: 1234, apiVersion: '2.0.0' };
const realTokenData = Buffer.alloc(165);
spl.AccountLayout.encode(
  {
    mint: realMint, owner: wallet, amount: 5n, delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  },
  realTokenData,
);
const realAcct = {
  data: [realTokenData.toString('base64'), 'base64'],
  executable: false, lamports: 2039280, owner: spl.TOKEN_PROGRAM_ID.toBase58(), rentEpoch: 18446744073709551615n, space: 165,
};

const realParsed = {
  program: 'spl-token',
  parsed: {
    info: {
      isNative: false, mint: realMint.toBase58(), owner: wallet.toBase58(), state: 'initialized',
      tokenAmount: { amount: '5', decimals: 0, uiAmount: 5, uiAmountString: '5' },
    },
    type: 'account',
  },
  space: 165,
};

function mockMethod(method, params) {
  switch (method) {
    case 'getSlot': return { result: 1234 };
    case 'getBalance': return { result: { context: ctx, value: 5000000000 } };
    case 'getAccountInfo': return { result: { context: ctx, value: params[0] === realAccount.toBase58() ? realAcct : null } };
    case 'getMultipleAccounts':
      return { result: { context: ctx, value: params[0].map((k) => (k === realAccount.toBase58() ? realAcct : null)) } };
    case 'getTokenAccountsByOwner': {
      const [owner, filter, cfg = {}] = params;
      if (filter.mint && filter.mint !== realMint.toBase58()) return { error: { code: -32602, message: 'Invalid param: could not find mint' } };
      const acct = cfg.encoding === 'jsonParsed' ? { ...realAcct, data: realParsed } : realAcct;
      const list = owner === wallet.toBase58() && (filter.mint || filter.programId === spl.TOKEN_PROGRAM_ID.toBase58())
        ? [{ pubkey: realAccount.toBase58(), account: acct }] : [];
      return { result: { context: ctx, value: list } };
    }
    case 'getProgramAccounts': return { result: [] };
    default: return { error: { code: -32601, message: 'Method not found' } };
  }
}

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSONbig.parse(body);
    const answer = (r) => ({ jsonrpc: '2.0', id: r.id, ...mockMethod(r.method, r.params || []) });
    const out = Array.isArray(parsed) ? parsed.map(answer).reverse() /* out of order on purpose */ : answer(parsed);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSONbig.stringify(out));
  });
});
const upstreamWs = new WebSocketServer({ port: UP_PORT + 1, host: '127.0.0.1' });
upstreamWs.on('connection', (ws) => ws.on('message', (m) => ws.send(JSON.stringify({ jsonrpc: '2.0', result: 42, id: JSON.parse(m).id }))));

// ------------------------------------------------------------ helpers

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
  }
}

async function rawRpc(body) {
  const r = await fetch(`http://127.0.0.1:${PX_PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.text();
}

function wsRoundTrip(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('timeout')), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'slotSubscribe' })));
    ws.on('message', (m) => { clearTimeout(t); ws.close(); resolve(JSON.parse(m)); });
    ws.on('error', reject);
  });
}

// ------------------------------------------------------------ run

(async () => {
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

  const cfgPath = path.join(os.tmpdir(), `injector-test-${process.pid}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({
    upstream: `http://127.0.0.1:${UP_PORT}`,
    port: PX_PORT,
    log: false,
    tokens: [
      { name: 'Night Token', symbol: 'NIGHT', decimals: 6, image: 'https://example.com/night.png', description: 'mirror', balances: { [wallet.toBase58()]: '1250.5', [otherWallet.toBase58()]: '10' } },
      { name: 'Dust 2022', symbol: 'DUST', decimals: 9, program: 'token-2022', uri: 'https://example.com/dust.json', balances: { [wallet.toBase58()]: '0.000000001' } },
    ],
  }));

  const proxy = spawn(process.execPath, [path.join(__dirname, '..', 'proxy.js'), cfgPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  let banner = '';
  await new Promise((resolve, reject) => {
    proxy.stdout.on('data', (d) => { banner += d; if (banner.includes('Point your wallet')) resolve(); });
    proxy.on('exit', (c) => reject(new Error(`proxy exited with ${c}`)));
  });

  const derive = (label) => new PublicKey(require('crypto').createHash('sha256').update(`solana-token-injector:${label}`).digest());
  const night = derive('mint:NIGHT');
  const dust = derive('mint:DUST');
  const nightAta = spl.getAssociatedTokenAddressSync(night, wallet);
  const dustAta = spl.getAssociatedTokenAddressSync(dust, wallet, false, spl.TOKEN_2022_PROGRAM_ID);
  const conn = new Connection(`http://127.0.0.1:${PX_PORT}`, 'confirmed');

  console.log('\nsolana-token-injector tests');

  await check('banner lists both mints', () => {
    assert.ok(banner.includes(night.toBase58()) && banner.includes(dust.toBase58()));
  });

  await check('parsed token accounts (Token program): real one kept, fake one added', async () => {
    const r = await conn.getParsedTokenAccountsByOwner(wallet, { programId: spl.TOKEN_PROGRAM_ID });
    const mints = r.value.map((a) => a.account.data.parsed.info.mint);
    assert.deepEqual(mints, [realMint.toBase58(), night.toBase58()]);
    const fake = r.value[1];
    assert.equal(fake.pubkey.toBase58(), nightAta.toBase58());
    assert.deepEqual(fake.account.data.parsed.info.tokenAmount, { amount: '1250500000', decimals: 6, uiAmount: 1250.5, uiAmountString: '1250.5' });
  });

  await check('parsed token accounts (Token-2022 program)', async () => {
    const r = await conn.getParsedTokenAccountsByOwner(wallet, { programId: spl.TOKEN_2022_PROGRAM_ID });
    assert.equal(r.value.length, 1);
    const info = r.value[0].account.data.parsed.info;
    assert.equal(info.mint, dust.toBase58());
    assert.equal(info.tokenAmount.uiAmountString, '0.000000001');
    assert.equal(r.value[0].account.owner.toBase58(), spl.TOKEN_2022_PROGRAM_ID.toBase58());
  });

  await check('base64 token accounts decode with spl-token (both programs)', async () => {
    const a = await conn.getTokenAccountsByOwner(wallet, { programId: spl.TOKEN_PROGRAM_ID });
    const acc = spl.unpackAccount(nightAta, a.value[1].account, spl.TOKEN_PROGRAM_ID);
    assert.equal(acc.amount, 1250500000n);
    assert.ok(acc.owner.equals(wallet) && acc.mint.equals(night));
    const b = await conn.getTokenAccountsByOwner(wallet, { programId: spl.TOKEN_2022_PROGRAM_ID });
    const acc2 = spl.unpackAccount(dustAta, b.value[0].account, spl.TOKEN_2022_PROGRAM_ID);
    assert.equal(acc2.amount, 1n);
    assert.deepEqual(spl.getExtensionTypes(acc2.tlvData), [spl.ExtensionType.ImmutableOwner]);
  });

  await check('filter by fake mint is answered locally (upstream would reject it)', async () => {
    const r = await conn.getParsedTokenAccountsByOwner(wallet, { mint: night });
    assert.equal(r.value.length, 1);
    assert.equal(r.value[0].pubkey.toBase58(), nightAta.toBase58());
  });

  await check('filter by unknown mint still returns upstream error', async () => {
    await assert.rejects(conn.getParsedTokenAccountsByOwner(wallet, { mint: Keypair.generate().publicKey }), /could not find mint/);
  });

  await check('other wallets are untouched', async () => {
    const stranger = Keypair.generate().publicKey;
    const r = await conn.getParsedTokenAccountsByOwner(stranger, { programId: spl.TOKEN_PROGRAM_ID });
    assert.equal(r.value.length, 0);
  });

  await check('getMint (Token) and parsed mint info', async () => {
    const m = await spl.getMint(conn, night);
    assert.equal(m.decimals, 6);
    assert.equal(m.supply, 1260500000n); // 1250.5 + 10
    assert.equal(m.mintAuthority, null);
    const p = await conn.getParsedAccountInfo(night);
    assert.equal(p.value.data.parsed.type, 'mint');
    assert.equal(p.value.data.parsed.info.supply, '1260500000');
  });

  await check('Token-2022 metadata extension reads back via getTokenMetadata', async () => {
    const m = await spl.getMint(conn, dust, 'confirmed', spl.TOKEN_2022_PROGRAM_ID);
    assert.equal(m.decimals, 9);
    const md = await spl.getTokenMetadata(conn, dust);
    assert.equal(md.name, 'Dust 2022');
    assert.equal(md.symbol, 'DUST');
    assert.equal(md.uri, 'https://example.com/dust.json');
    const p = await conn.getParsedAccountInfo(dust);
    const exts = p.value.data.parsed.info.extensions.map((e) => e.extension);
    assert.deepEqual(exts, ['metadataPointer', 'tokenMetadata']);
  });

  await check('Metaplex metadata PDA deserializes with mpl-token-metadata', async () => {
    const { Metadata } = require('@metaplex-foundation/mpl-token-metadata');
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), MPL.toBuffer(), night.toBuffer()], MPL);
    const info = await conn.getAccountInfo(pda);
    assert.ok(info.owner.equals(MPL));
    const [md] = Metadata.deserialize(info.data);
    assert.equal(md.data.name.replace(/\0+$/, ''), 'Night Token');
    assert.equal(md.data.symbol.replace(/\0+$/, ''), 'NIGHT');
    assert.equal(md.data.uri.replace(/\0+$/, ''), `http://127.0.0.1:${PX_PORT}/token-metadata/NIGHT.json`);
    assert.ok(md.mint.equals(night));
    assert.equal(md.tokenStandard, 2); // Fungible
    // jsonParsed on a Metaplex account falls back to base64, as a real node does
    const parsed = await conn.getParsedAccountInfo(pda);
    assert.ok(Buffer.isBuffer(parsed.value.data));
  });

  await check('served metadata JSON for tokens without a uri', async () => {
    const r = await fetch(`http://127.0.0.1:${PX_PORT}/token-metadata/NIGHT.json`);
    assert.deepEqual(await r.json(), { name: 'Night Token', symbol: 'NIGHT', description: 'mirror', image: 'https://example.com/night.png' });
  });

  await check('balance / supply / largest accounts', async () => {
    const b = await conn.getTokenAccountBalance(nightAta);
    assert.equal(b.value.uiAmountString, '1250.5');
    assert.equal(b.context.slot, 1234);
    const s = await conn.getTokenSupply(night);
    assert.equal(s.value.amount, '1260500000');
    const l = await conn.getTokenLargestAccounts(night);
    assert.equal(l.value[0].address.toBase58(), nightAta.toBase58());
    assert.equal(l.value.length, 2);
  });

  await check('getMultipleAccounts patches only fake slots and keeps u64 rentEpoch exact', async () => {
    const infos = await conn.getMultipleAccountsInfo([realAccount, night, Keypair.generate().publicKey]);
    assert.ok(infos[0].owner.equals(spl.TOKEN_PROGRAM_ID));
    assert.equal(spl.unpackMint(night, infos[1]).decimals, 6);
    assert.equal(infos[2], null);
    const raw = await rawRpc({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [[realAccount.toBase58(), night.toBase58()], { encoding: 'base64' }] });
    assert.equal(raw.match(/"rentEpoch":18446744073709551615[,}]/g).length, 2);
  });

  await check('getProgramAccounts applies dataSize/memcmp filters to fake accounts', async () => {
    const mine = await conn.getProgramAccounts(spl.TOKEN_PROGRAM_ID, {
      filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: wallet.toBase58() } }],
    });
    assert.deepEqual(mine.map((a) => a.pubkey.toBase58()), [nightAta.toBase58()]);
    const none = await conn.getProgramAccounts(spl.TOKEN_PROGRAM_ID, {
      filters: [{ dataSize: 165 }, { memcmp: { offset: 32, bytes: Keypair.generate().publicKey.toBase58() } }],
    });
    assert.equal(none.length, 0);
    const t22 = await conn.getProgramAccounts(spl.TOKEN_2022_PROGRAM_ID, { filters: [{ memcmp: { offset: 32, bytes: wallet.toBase58() } }] });
    assert.deepEqual(t22.map((a) => a.pubkey.toBase58()), [dustAta.toBase58()]);
  });

  await check('batch: ids and order preserved across local + forwarded + patched', async () => {
    const out = JSON.parse(await rawRpc([
      { jsonrpc: '2.0', id: 'a', method: 'getBalance', params: [wallet.toBase58()] },
      { jsonrpc: '2.0', id: 'b', method: 'getTokenSupply', params: [night.toBase58()] },
      { jsonrpc: '2.0', id: 7, method: 'getTokenAccountsByOwner', params: [wallet.toBase58(), { programId: spl.TOKEN_PROGRAM_ID.toBase58() }, { encoding: 'jsonParsed' }] },
      { jsonrpc: '2.0', id: 8, method: 'noSuchMethod', params: [] },
    ]));
    assert.deepEqual(out.map((r) => r.id), ['a', 'b', 7, 8]);
    assert.equal(out[0].result.value, 5000000000);
    assert.equal(out[1].result.value.uiAmountString, '1260.5');
    assert.equal(out[2].result.value.length, 2);
    assert.equal(out[3].error.code, -32601);
  });

  await check('untouched single calls pass through byte-for-byte', async () => {
    const body = { jsonrpc: '2.0', id: 3, method: 'getBalance', params: [wallet.toBase58()] };
    const direct = await (await fetch(`http://127.0.0.1:${UP_PORT}`, { method: 'POST', body: JSON.stringify(body) })).text();
    assert.equal(await rawRpc(body), direct);
  });

  await check('CORS preflight', async () => {
    const r = await fetch(`http://127.0.0.1:${PX_PORT}`, { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });

  await check('websocket passthrough on port and port+1', async () => {
    assert.equal((await wsRoundTrip(`ws://127.0.0.1:${PX_PORT + 1}`)).result, 42);
    assert.equal((await wsRoundTrip(`ws://127.0.0.1:${PX_PORT}`)).result, 42);
  });

  console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
  proxy.kill();
  upstream.close();
  upstreamWs.close();
  fs.unlinkSync(cfgPath);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
