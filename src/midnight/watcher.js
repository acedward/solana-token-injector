'use strict';
// Follows ONE viewing key on the Midnight indexer (FR-105, FR-106):
//   1. POST `connect(viewingKey)` -> session id;
//   2. its own graphql-ws client (the indexer limits session subscriptions per
//      connection) subscribes to `shieldedTransactions(sessionId, index: 0)`;
//   3. each RelevantTransaction -> decryptor `decrypt` -> coins kept by the
//      counting rule (counting.js), de-duplicated by commitment (CoinBook);
//   4. ShieldedTransactionsProgress -> `syncing` / `synced` (sync rule below);
//   5. errors / socket close -> `error` status, totals kept, reconnect with
//      exponential backoff (fresh `connect`, resubscribe from index 0);
//   6. stop(): dispose the subscription, `disconnect(sessionId)` best effort.
// One watcher per distinct viewing key: `connect` keeps one session per key
// on the indexer side, so registrations sharing a key share the watcher.
//
// Sync rule (lane A, indexer 4.4.0-rc.1): progress numbers cannot tell when a
// newly connected key has caught up — highestCheckedEndIndex is the maximum
// over all wallets and is cached for up to 5 s, so a new session first reports
// nothing relevant and its first transactions arrive seconds later. While a
// subscription catches up, `synced` needs a progress event that arrives at
// least `syncMinMs` (10 s) after the subscription started, with checked >=
// highest, and no RelevantTransaction in the `syncQuietMs` (5 s) before it.
// Once synced, the subscription stays synced unless a progress event shows
// checked < highest.

const EventEmitter = require('events');
const WebSocket = require('ws');
const { createClient } = require('graphql-ws/client');
const log = require('../log');
const { CoinBook } = require('./coins');
const { countableCoins, progressSynced } = require('./counting');
const { DecryptError } = require('./decryptor');

const CONNECT_MUTATION = 'mutation Connect($viewingKey: ViewingKey!) { connect(viewingKey: $viewingKey) }';
const DISCONNECT_MUTATION = 'mutation Disconnect($sessionId: HexEncoded!) { disconnect(sessionId: $sessionId) }';

// Same selection as the 2.x wallet SDK (midnight-wallet packages/indexer-client
// src/graphql/subscriptions/ShieldedTransactions.ts).
const SUBSCRIPTION = `subscription ShieldedTransactions($sessionId: HexEncoded!, $index: Int) {
  shieldedTransactions(sessionId: $sessionId, index: $index) {
    __typename
    ... on ShieldedTransactionsProgress { highestEndIndex highestCheckedEndIndex highestRelevantEndIndex }
    ... on RelevantTransaction {
      transaction { id raw hash protocolVersion identifiers startIndex endIndex
        fees { paidFees estimatedFees }
        transactionResult { status segments { id success } } }
      collapsedMerkleTree { startIndex endIndex update protocolVersion }
    }
  }
}`;

class WatcherError extends Error {}

function describeError(err) {
  if (!err) return 'unknown error';
  if (Array.isArray(err)) return err.map((e) => (e && e.message) || String(e)).join('; ') || 'subscription error';
  if (typeof err.code === 'number' && 'reason' in err) {
    return `indexer websocket closed (code ${err.code}${err.reason ? `: ${err.reason}` : ''})`;
  }
  if (err.cause && err.cause.code) return `${err.message} (${err.cause.code})`;
  return err.message || String(err);
}

async function graphqlPost(url, query, variables, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new WatcherError(`indexer unreachable: ${describeError(err)}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new WatcherError(`indexer HTTP ${res.status}: not a GraphQL answer`);
  }
  if (body.errors && body.errors.length) throw new WatcherError(`indexer: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!res.ok) throw new WatcherError(`indexer HTTP ${res.status}`);
  return body.data;
}

class KeyWatcher extends EventEmitter {
  constructor({
    viewingKey,
    networkId,
    indexerHttp,
    indexerWs,
    decryptor,
    reconnectMinMs = 1000,
    reconnectMaxMs = 30000,
    httpTimeoutMs = 15000,
    syncMinMs = 10000,
    syncQuietMs = 5000,
  }) {
    super();
    this.viewingKey = viewingKey;
    this.networkId = networkId;
    this.indexerHttp = indexerHttp;
    this.indexerWs = indexerWs;
    this.decryptor = decryptor;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.httpTimeoutMs = httpTimeoutMs;
    this.syncMinMs = syncMinMs;
    this.syncQuietMs = syncQuietMs;

    this.status = 'connecting';
    this.error = null;
    this.book = new CoinBook();
    this.lastEventAt = null;
    this.progress = null;
    this.transactions = 0; // relevant transactions processed (re-deliveries included)
    this.skipped = 0; // transactions the decryptor could not decode
    this.sessionId = null;
    this.connects = 0;
    this.subscribedAt = 0; // when the current subscription was opened
    this.lastTxArrivedAt = null; // arrival of the last RelevantTransaction on it
    this.caughtUp = false; // the current subscription has reached `synced` once

    this.stopped = false;
    this.generation = 0;
    this.backoff = reconnectMinMs;
    this.chain = Promise.resolve();
    this.client = null;
    this.abortCurrent = null;
    this.sleepTimer = null;
    this.sleepResolve = null;
  }

  get label() {
    return log.maskKey(this.viewingKey);
  }

  start() {
    this.loop = this._run();
    return this;
  }

  _set(status, error = null) {
    const changed = this.status !== status || this.error !== error;
    this.status = status;
    this.error = error;
    if (changed) this.emit('change', { kind: 'status' });
  }

  async _run() {
    while (!this.stopped) {
      const gen = ++this.generation;
      try {
        const data = await graphqlPost(this.indexerHttp, CONNECT_MUTATION, { viewingKey: this.viewingKey }, this.httpTimeoutMs);
        if (!data || typeof data.connect !== 'string') throw new WatcherError('indexer: connect returned no session id');
        this.sessionId = data.connect;
        this.connects++;
        if (this.stopped) break;
        await this._subscribe(gen, this.sessionId);
        if (!this.stopped) throw new WatcherError('indexer ended the subscription');
      } catch (err) {
        if (this.stopped) break;
        const msg = log.redact(describeError(err));
        log.warn(`watcher ${this.label}: ${msg}; reconnecting in ${this.backoff} ms`);
        this._set('error', msg);
      }
      if (this.stopped) break;
      await this._sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.reconnectMaxMs);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(resolve, ms);
    });
  }

  _subscribe(gen, sessionId) {
    return new Promise((resolve, reject) => {
      const client = createClient({
        url: this.indexerWs,
        webSocketImpl: WebSocket,
        lazy: true,
        retryAttempts: 0,
        shouldRetry: () => false,
        keepAlive: 15000,
        connectionAckWaitTimeout: 15000,
      });
      this.client = client;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        // Retire this subscription: events it already queued are now stale.
        if (this.generation === gen) this.generation++;
        this.abortCurrent = null;
        if (this.client === client) this.client = null;
        Promise.resolve(client.dispose()).catch(() => {});
        if (err) reject(err);
        else resolve();
      };
      this.abortCurrent = finish;
      this.subscribedAt = Date.now();
      this.lastTxArrivedAt = null;
      this.caughtUp = false;
      client.subscribe(
        { query: SUBSCRIPTION, variables: { sessionId, index: 0 } },
        {
          next: (msg) => this._enqueue(gen, msg),
          error: (err) => finish(err instanceof Error ? err : new WatcherError(describeError(err))),
          complete: () => finish(),
        },
      );
    });
  }

  _enqueue(gen, msg) {
    const arrivedAt = Date.now();
    const ev = msg && msg.data && msg.data.shieldedTransactions;
    if (ev && ev.__typename === 'RelevantTransaction' && gen === this.generation) this.lastTxArrivedAt = arrivedAt;
    msg = { ...msg, arrivedAt };
    this.chain = this.chain
      .then(() => this._handle(gen, msg))
      .catch((err) => {
        // Decryptor unreachable or similar: this subscription's coins may be
        // incomplete, so drop it and resubscribe from 0 (dedupe absorbs repeats).
        if (gen !== this.generation || !this.abortCurrent) return;
        this.abortCurrent(new WatcherError(`decryptor: ${log.redact(err.message)}`));
      });
  }

  async _handle(gen, msg) {
    if (gen !== this.generation || this.stopped) return; // stale event from a dropped subscription
    if (msg.errors && msg.errors.length) throw new WatcherError(msg.errors.map((e) => e.message).join('; '));
    const ev = msg.data && msg.data.shieldedTransactions;
    if (!ev) return;
    this.lastEventAt = new Date().toISOString();
    this.backoff = this.reconnectMinMs; // a working subscription resets the backoff
    if (ev.__typename === 'ShieldedTransactionsProgress') {
      this.progress = {
        highestEndIndex: ev.highestEndIndex ?? ev.highestZswapEndIndex ?? null,
        highestCheckedEndIndex: ev.highestCheckedEndIndex ?? ev.highestCheckedZswapEndIndex ?? null,
        highestRelevantEndIndex: ev.highestRelevantEndIndex ?? ev.highestRelevantZswapEndIndex ?? null,
      };
      this._set(this._syncedAfter(ev, msg.arrivedAt) ? 'synced' : 'syncing');
      return;
    }
    if (ev.__typename !== 'RelevantTransaction' || !ev.transaction) return;
    const tx = ev.transaction;
    let coins;
    try {
      coins = await this.decryptor.decrypt(this.networkId, this.viewingKey, tx.raw);
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      this.skipped++;
      log.warn(`watcher ${this.label}: transaction ${tx.hash || tx.id} skipped: ${err.message}`);
      return;
    }
    if (gen !== this.generation || this.stopped) return;
    if (this.status === 'error' || this.status === 'connecting') this._set('syncing');
    this.transactions++;
    let added = 0;
    for (const c of countableCoins(coins, tx.transactionResult)) {
      try {
        if (this.book.add(c)) added++;
      } catch (err) {
        log.warn(`watcher ${this.label}: bad coin in transaction ${tx.hash || tx.id}: ${err.message}`);
      }
    }
    if (added) this.emit('change', { kind: 'coins', added });
  }

  /** Sync rule (see the header): is the key caught up, given this progress event? */
  _syncedAfter(ev, arrivedAt) {
    if (!progressSynced(ev)) return false;
    if (this.caughtUp) return true;
    const oldEnough = arrivedAt - this.subscribedAt >= this.syncMinMs;
    const quiet = this.lastTxArrivedAt === null || arrivedAt - this.lastTxArrivedAt >= this.syncQuietMs;
    if (oldEnough && quiet) this.caughtUp = true;
    return this.caughtUp;
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      totals: new Map(this.book.totals),
      coins: this.book.size,
      transactions: this.transactions,
      skipped: this.skipped,
      lastEventAt: this.lastEventAt,
      progress: this.progress,
    };
  }

  /** Stops following the key: dispose the subscription, then `disconnect` best effort. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    if (this.sleepResolve) this.sleepResolve();
    if (this.abortCurrent) this.abortCurrent();
    if (this.client) await Promise.resolve(this.client.dispose()).catch(() => {});
    await (this.loop || Promise.resolve()).catch(() => {});
    if (this.sessionId) {
      try {
        await graphqlPost(this.indexerHttp, DISCONNECT_MUTATION, { sessionId: this.sessionId }, 5000);
      } catch (err) {
        log.warn(`watcher ${this.label}: disconnect failed (ignored): ${log.redact(err.message)}`);
      }
    }
    this.removeAllListeners();
  }
}

module.exports = { KeyWatcher, SUBSCRIPTION, CONNECT_MUTATION, DISCONNECT_MUTATION, describeError };
