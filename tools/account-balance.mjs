#!/usr/bin/env node
// A Passport account's exact balance, computed with Night Market's own page code (the vendored bundle,
// plan D1) from public chain data plus the account's X25519 inbox secret (AA 00059, interface I-T).
//
//   node tools/account-balance.mjs --indexer <http url> [--indexer-ws <ws url>] --network <id> \
//     --account <64 hex> --secret-file <path> [--record <file>]
//
// Prints one JSON object:
//   {account, stateHeight, encKeyMatches, history: {complete, throughHeight, txs, gap?},
//    holdings: [{colour, total, coins, notInInbox}], unshielded: [{colour, amount}],
//    unseenCoins, unconfirmedNotes, unreadableEntries}
// with amounts as decimal strings. What the page does (web/src/passport/operations.ts syncAccount):
// read the state, open every inbox entry with the secret, read the account's complete history and
// decode it with ledger-v9, reconcile (a coin counts only when its leaf is on chain; spent by its
// nullifier), holdingsByColour. The injector has no browser-local coins (a withdrawal's change that
// Night Market has not filed): `unseenCoins` counts them (plan D9).
//
// The secret is read from the file and never printed. `--record` writes the GraphQL request/response
// pairs (public chain data) and the opened coin plaintexts by inbox index, never the secret.

import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket as WsWebSocket } from 'ws';

import * as nm from '../vendor/night-market/night-market-core.mjs';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  for (const k of ['indexer', 'network', 'account', 'secret-file']) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

const low = (h) => String(h).replace(/^0x/, '').toLowerCase();
const hexBytes = (h) => Uint8Array.from(Buffer.from(low(h), 'hex'));
const wsOf = (http) => {
  const u = new URL(http);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`;
  return u.toString();
};

/** The page's subscription reader passes the protocol name; `ws` takes it the same way. Recorded. */
function recordingWebSocket(log) {
  return class RecordingWebSocket extends WsWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const entry = { url: String(url), sent: [], received: [] };
      log.push(entry);
      const send = this.send.bind(this);
      this.send = (data, ...rest) => {
        entry.sent.push(JSON.parse(String(data)));
        return send(data, ...rest);
      };
      this.addEventListener('message', (ev) => entry.received.push(JSON.parse(String(ev.data))));
    }
  };
}

export async function accountBalance({ indexer, indexerWs, network, account, secretHex, record = null }) {
  const address = low(account);
  if (!/^[0-9a-f]{64}$/.test(address)) throw new Error('--account must be 64 hex');
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error('the secret file must hold 64 hex');
  const pairs = [];
  const wsLog = [];
  const graphql = async (query, variables) => {
    const res = await fetch(indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    pairs.push({ request: { query, variables }, response: body });
    if (body.errors?.length) throw new Error(`indexer: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  };

  // 1. The state (the page's STATE_QUERY), decoded with the account's own ledger().
  const st = await graphql(nm.ACCOUNT_STATE_QUERY, { address });
  if (!st.contract?.state) throw new Error(`the indexer has no contract at ${address}`);
  const decoded = nm.decodeAccountState(address, st.contract.state);
  const stateHeight = st.block?.height ?? 0;
  const encPublic = nm.encPublicKeyOf(secretHex);
  const encKeyMatches = encPublic === decoded.view.encKey.toLowerCase();

  // 2. The inbox, opened with the secret (as syncAccount does: entries that do not open are counted).
  const sk = hexBytes(secretHex);
  const inbox = [];
  const opened = [];
  let unreadableEntries = 0;
  for (const [i, entry] of decoded.inbox.entries()) {
    if (!entry) continue;
    const coin = await nm.openEntryPortable(sk, hexBytes(entry));
    if (!coin) {
      unreadableEntries++;
      continue;
    }
    const c = {
      nonce: Buffer.from(coin.nonce).toString('hex'),
      color: Buffer.from(coin.color).toString('hex'),
      value: coin.value.toString(10),
      inboxIndex: String(i),
    };
    inbox.push(c);
    opened.push(c);
  }

  // 3. The complete history, read AFTER the state (R3-4), decoded with ledger-v9 (the page's reader).
  const reader = new nm.AccountHistoryReader({
    graphql,
    wsUrl: indexerWs ?? wsOf(indexer),
    WebSocketImpl: recordingWebSocket(wsLog),
  });
  const history = await reader.history(address);
  const activity = nm.activityOf(history);

  // 4. Reconcile and hold (no browser-local coins here).
  const coins = nm.reconcileCoins({ account: address, inbox, outputs: activity.outputs, inputs: activity.inputs, previous: [] });
  const holdings = nm.holdingsByColour(coins).map((h) => ({
    colour: h.color,
    total: h.total.toString(10),
    coins: h.coins,
    notInInbox: h.notInInbox,
  }));

  // 5. Diagnostics (plan D9): leaves no opened coin explains, minus spends no opened coin explains.
  const commitments = new Set(coins.map((c) => c.commitment));
  const nullifiers = new Set(coins.map((c) => nm.contractCoinNullifier(c, address)));
  const unexplainedLeaves = activity.outputs.filter((o) => !commitments.has(low(o.commitment))).length;
  const unexplainedSpends = activity.inputs.filter((i) => !nullifiers.has(low(i.nullifier))).length;
  const out = {
    account: address,
    stateHeight,
    encKeyMatches,
    history: {
      complete: history.complete,
      throughHeight: history.throughHeight,
      txs: history.txs.length,
      ...(history.gap ? { gap: history.gap } : {}),
    },
    holdings,
    unshielded: decoded.unshielded.map((u) => ({ colour: u.colour, amount: u.amount })),
    unseenCoins: Math.max(0, unexplainedLeaves - unexplainedSpends),
    unconfirmedNotes: coins.filter((c) => !c.spent && !nm.confirmedOnChain(c)).length,
    unreadableEntries,
  };
  if (record) {
    writeFileSync(
      record,
      `${JSON.stringify({ network, account: address, graphql: pairs, websocket: wsLog, opened, result: out }, null, 1)}\n`,
    );
  }
  return out;
}

const isMain = import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const a = args(process.argv.slice(2));
    const secretHex = low(readFileSync(a['secret-file'], 'utf8').trim());
    const out = await accountBalance({
      indexer: a.indexer,
      indexerWs: a['indexer-ws'],
      network: a.network,
      account: a.account,
      secretHex,
      record: a.record ?? null,
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`account-balance: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}
