'use strict';
// AccountWatcher (AA 00059 P2, plan D3/D5/D8/D9): follows ONE registered Passport account by polling,
// with Night Market's own page logic (the vendored bundle):
//
//   each poll: the state (`contract { state }`, decoded with the account's own ledger()), the inbox
//   entries opened with every key of the ring (cached by index and ciphertext), the account's complete
//   history read AFTER the state (one AccountHistoryReader kept across polls: it decodes only what is
//   new), `reconcileCoins` (a coin counts only when its leaf is on chain; spent by its nullifier),
//   `holdingsByColour`, the unshielded balances from the state, and the diagnostics of D9.
//
// Statuses: syncing (no complete computation yet; persisted amounts after a restart), synced,
// incomplete (the history is not complete: amounts from what was read, flagged), stale-key (no held
// key derives the on-chain enc_key: amounts frozen), error (the poll failed: amounts frozen). Errors
// back off from backoffMinMs doubling to backoffMaxMs. Emits 'change' (with the snapshot) when the
// status, the amounts or the diagnostics change. The secrets are never logged or put in an error.

const { EventEmitter } = require('events');

const low = (h) => String(h).replace(/^0x/, '').toLowerCase();
const hexBytes = (h) => new Uint8Array(Buffer.from(low(h), 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');

/** Amounts as plain JSON: {shielded: {hex: "n"}, unshielded: {hex: "n"}}. */
function amountsJson(a) {
  if (!a) return null;
  const obj = (m) => Object.fromEntries([...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([k, v]) => [k, v.toString(10)]));
  return { shielded: obj(a.shielded), unshielded: obj(a.unshielded) };
}
function amountsFromJson(j) {
  if (!j) return null;
  const map = (o) => new Map(Object.entries(o || {}).map(([k, v]) => [k, BigInt(v)]));
  return { shielded: map(j.shielded), unshielded: map(j.unshielded) };
}

class AccountWatcher extends EventEmitter {
  /**
   * opts: { address, keys: [{secret, publicKey}], nm (bundle), chain (createIndexerReader),
   *   pollMs = 5000, backoffMinMs = 2000, backoffMaxMs = 60000, historyPageLimit?,
   *   limit? (fn => promise: the service's cap on concurrent polls), initialAmounts? (persisted JSON),
   *   openEntry? (async (entryBytes, keys) => coin | null; tests), now? }
   */
  constructor(opts) {
    super();
    this.address = low(opts.address);
    this.nm = opts.nm;
    this.chain = opts.chain;
    this.pollMs = opts.pollMs ?? 5000;
    this.backoffMinMs = opts.backoffMinMs ?? 2000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 60000;
    this.limit = opts.limit || ((fn) => fn());
    this.now = opts.now || (() => new Date());
    this.openEntry = opts.openEntry || ((entry, keys) => this._open(entry, keys));
    this.keys = opts.keys.map((k) => ({ secret: low(k.secret), publicKey: low(k.publicKey) }));
    this.reader = this.chain.historyReader({ pageLimit: opts.historyPageLimit });
    this.inbox = new Map(); // index -> { entry, coin | null, tried: Set<publicKey> }
    this.amounts = amountsFromJson(opts.initialAmounts);
    this.status = 'syncing';
    this.error = null;
    this.lastCheckedAt = null;
    this.history = { complete: false, throughHeight: 0 };
    this.diag = { unseenCoins: 0, unconfirmedNotes: 0, unreadableEntries: 0 };
    this.timer = null;
    this.stopped = true;
    this.failures = 0;
    this.inflight = null;
    this.lastEmitted = JSON.stringify(this._compare());
  }

  start() {
    this.stopped = false;
    this._schedule(0);
    return this;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight.catch(() => {});
  }

  /** A new ring (re-registration): entries no key opened are tried again; a poll follows at once. */
  setKeys(keys) {
    this.keys = keys.map((k) => ({ secret: low(k.secret), publicKey: low(k.publicKey) }));
    this._schedule(0);
  }

  _schedule(ms) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollNow().catch(() => {});
    }, ms);
    this.timer.unref?.();
  }

  /** One poll now (concurrent calls share it). */
  pollNow() {
    if (this.inflight) return this.inflight;
    this.inflight = this.limit(() => this._poll()).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async _open(entry, keys) {
    for (const k of keys) {
      const coin = await this.nm.openEntryPortable(hexBytes(k.secret), entry);
      if (coin) return coin;
    }
    return null;
  }

  async _poll() {
    let next = this.pollMs;
    try {
      await this._compute();
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.status = 'error';
      this.error = e && e.message ? String(e.message) : String(e);
      next = Math.min(this.backoffMinMs * 2 ** (this.failures - 1), this.backoffMaxMs);
    }
    this.lastCheckedAt = this.now().toISOString();
    this._emitIfChanged();
    this._schedule(next);
  }

  async _compute() {
    const nm = this.nm;
    // 1. The state first (R3-4: a history read after it covers everything the state reflects).
    const read = await this.chain.readAccountState(this.address);
    if (!read) throw new Error('the indexer has no contract at this address');
    const d = nm.decodeAccountState(this.address, read.state);
    const encKey = low(d.view.encKey);
    const keyMatch = this.keys.some((k) => k.publicKey === encKey);

    // 2. The inbox, opened with every held key (D5), cached by index and ciphertext.
    const inbox = [];
    let unreadable = 0;
    for (const [i, entry] of d.inbox.entries()) {
      if (!entry) continue;
      const e = low(entry);
      let c = this.inbox.get(i);
      if (!c || c.entry !== e) c = { entry: e, coin: null, tried: new Set() };
      const untried = this.keys.filter((k) => !c.tried.has(k.publicKey));
      if (!c.coin && untried.length > 0) {
        const coin = await this.openEntry(hexBytes(e), untried);
        for (const k of untried) c.tried.add(k.publicKey);
        if (coin) c.coin = { nonce: toHex(coin.nonce), color: toHex(coin.color), value: coin.value.toString(10) };
      }
      this.inbox.set(i, c);
      if (c.coin) inbox.push({ ...c.coin, inboxIndex: String(i) });
      else unreadable++;
    }

    // 3. The complete history (Night Market's reader: newest page over HTTP, older over the stream).
    const history = await this.reader.history(this.address);
    const activity = nm.activityOf(history);

    // 4. Reconcile (no browser-local coins here) and hold.
    const coins = nm.reconcileCoins({ account: this.address, inbox, outputs: activity.outputs, inputs: activity.inputs, previous: [] });
    const shielded = new Map(nm.holdingsByColour(coins).map((h) => [low(h.color), h.total]));
    const unshielded = new Map(d.unshielded.map((u) => [low(u.colour), BigInt(u.amount)]));

    // 5. D9: leaves no opened coin explains, minus spends no opened coin explains.
    const commitments = new Set(coins.map((c) => c.commitment));
    const nullifiers = new Set(coins.map((c) => nm.contractCoinNullifier(c, this.address)));
    const leaves = activity.outputs.filter((o) => !commitments.has(low(o.commitment))).length;
    const spends = activity.inputs.filter((x) => !nullifiers.has(low(x.nullifier))).length;
    this.diag = {
      unseenCoins: Math.max(0, leaves - spends),
      unconfirmedNotes: coins.filter((c) => !c.spent && !nm.confirmedOnChain(c)).length,
      unreadableEntries: unreadable,
    };
    this.history = { complete: history.complete, throughHeight: history.throughHeight };
    this.stateHeight = read.blockHeight;

    if (!keyMatch) {
      // D8: the amounts stay those of the last computation before the rotation.
      this.status = 'stale-key';
      this.error = 'the account\'s encryption key changed to one this registration does not hold; register again with the new key';
      return;
    }
    this.amounts = { shielded, unshielded };
    if (history.complete) {
      this.status = 'synced';
      this.error = null;
    } else {
      this.status = 'incomplete';
      this.error = history.gap || 'the account\'s history is not complete';
    }
  }

  _compare() {
    return { status: this.status, error: this.error, amounts: amountsJson(this.amounts), diag: this.diag, history: this.history };
  }

  _emitIfChanged() {
    const now = JSON.stringify(this._compare());
    if (now === this.lastEmitted) return;
    this.lastEmitted = now;
    this.emit('change', this.snapshot());
  }

  /** The current view of the account (no secret). */
  snapshot() {
    return {
      status: this.status,
      error: this.error,
      lastCheckedAt: this.lastCheckedAt,
      history: { ...this.history },
      ...this.diag,
      amounts: this.amounts,
      amountsJson: amountsJson(this.amounts),
    };
  }
}

module.exports = { AccountWatcher, amountsJson, amountsFromJson };
