'use strict';
// AccountService (AA 00059 P2/P3): the account registrations (store), one AccountWatcher per
// registration, the registration checks of I-4 (src/accounts/validate.js) and the bridge to the token
// manager. Watcher changes schedule a debounced TokenState rebuild and a debounced save of the amounts
// being served (D8); a registration rebuilds before it answers.
//
// tokenInputs() -> [{ solanaAddress, totals: Map<key, bigint> }] with shielded keys "<hex>" and
// unshielded keys "u:<hex>" (D6), the shape src/tokens/midnight.js sums with the viewing-key ones.

const { AccountStore } = require('./store');
const { AccountWatcher, amountsJson } = require('./watcher');
const { createIndexerReader } = require('./chain');
const { validateRegistration } = require('./validate');
const { AccountApiError } = require('./errors');
const { originOf, registrationInfo, DEFAULT_MAX_TTL_SECONDS } = require('./message');
const { midnightTokenId, tokenInfoFor, totalsByAddress } = require('../tokens/midnight');
const { deriveKey } = require('../tokens/accounts');
const { uiAmountString, U64_MAX } = require('../amounts');
const log = require('../log');

const STATUSES = ['syncing', 'synced', 'incomplete', 'stale-key', 'error'];

/** A cap on concurrent work: limit(fn) runs fn when fewer than n are running. */
function createLimit(n) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= n || queue.length === 0) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

class AccountService {
  /**
   * opts: { midnight (normalized config; midnight.accounts = {enabled, pollMs, maxConcurrent,
   *   maxTtlSeconds, keySet}), publicUrl, dataDir, nm (the vendored bundle, loaded),
   *   onChange, onChangeNow, getLookup () -> lookup(key), getAllInputs? () -> every token input
   *   (viewing keys and accounts: for the u64 clamp), chain? (tests), createWatcher? (tests), now? }
   */
  constructor(opts) {
    this.midnight = opts.midnight;
    this.cfg = opts.midnight.accounts;
    this.networkId = opts.midnight.networkId;
    this.origin = originOf(opts.publicUrl);
    this.nm = opts.nm;
    this.onChange = opts.onChange || (() => {});
    this.onChangeNow = opts.onChangeNow || (() => {});
    this.getLookup = opts.getLookup || (() => () => null);
    this.getAllInputs = opts.getAllInputs || (() => this.tokenInputs());
    this.now = opts.now || (() => new Date());
    this.store = new AccountStore(opts.dataDir);
    this.chain = opts.chain || createIndexerReader({ indexerHttp: this.midnight.indexerHttp, indexerWs: this.midnight.indexerWs, nm: this.nm });
    this.pinnedKeys = this.cfg.keySet || this.nm.PINNED_ACCOUNT_KEYS.circuits;
    this.limit = createLimit(this.cfg.maxConcurrent || 4);
    this.watchers = new Map(); // id -> AccountWatcher
    this.createWatcher =
      opts.createWatcher ||
      ((record) =>
        new AccountWatcher({
          address: record.accountAddress,
          keys: record.keys,
          nm: this.nm,
          chain: this.chain,
          pollMs: this.cfg.pollMs,
          limit: this.limit,
          initialAmounts: record.lastAmounts,
        }));
    this.saveTimer = null;
  }

  /** Loads the store and follows every registration of this network. */
  start() {
    this.store.load();
    for (const r of this.store.list()) if (r.networkId === this.networkId) this._follow(r);
    const n = this.store.list().length;
    if (n) log.line(`account registrations: ${n} loaded, ${this.watchers.size} followed`);
    return this;
  }

  _follow(record) {
    const w = this.createWatcher(record);
    w.on('change', (snap) => this._changed(record.id, snap));
    this.watchers.set(record.id, w);
    w.start();
    return w;
  }

  _changed(id, snap) {
    const r = this.store.get(id);
    if (r && (snap.status === 'synced' || snap.status === 'incomplete') && snap.amountsJson) {
      if (JSON.stringify(r.lastAmounts) !== JSON.stringify(snap.amountsJson)) {
        this.store.setAmounts(id, snap.amountsJson, this.now());
        this._saveSoon();
      }
    }
    this.onChange();
  }

  _saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this._saveNow();
    }, 1000);
    this.saveTimer.unref?.();
  }

  _saveNow() {
    try {
      this.store.save();
    } catch (err) {
      log.warn(`account store write failed (amounts kept in memory): ${err.message}`);
    }
  }

  info() {
    return registrationInfo({ origin: this.origin, networkId: this.networkId, maxTtlSeconds: this.cfg.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS });
  }

  /** I-4 steps 1-17. Returns { record, created, replacedKey }; throws AccountApiError. */
  async register(body) {
    const checked = await validateRegistration(body, {
      origin: this.origin,
      networkId: this.networkId,
      maxTtlSeconds: this.cfg.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS,
      now: () => Math.floor(this.now().getTime() / 1000),
      nm: this.nm,
      pinnedKeys: this.pinnedKeys,
      chain: this.chain,
    });
    let res;
    try {
      res = this.store.upsert({
        solanaAddress: checked.solanaAddress,
        accountAddress: checked.accountAddress,
        networkId: this.networkId,
        secret: checked.viewingKey,
        publicKey: checked.encPublicKey,
        now: this.now(),
      });
    } catch (err) {
      log.warn(`account store write failed: ${err.message}`);
      throw new AccountApiError('storage-error', 'could not save the registration (storage error)');
    }
    const { record, created, replacedKey } = res;
    if (created) {
      this._follow(record);
      log.line(`account registration ${record.id} added: ${record.solanaAddress} -> ${record.accountAddress.slice(0, 16)}… (key ${checked.encPublicKey.slice(0, 8)})`);
    } else if (replacedKey) {
      const w = this.watchers.get(record.id);
      if (w) w.setKeys(record.keys);
      else if (record.networkId === this.networkId) this._follow(record);
      log.line(`account registration ${record.id}: key replaced (key ${checked.encPublicKey.slice(0, 8)}, ${record.keys.length} held)`);
    }
    this.onChangeNow();
    return res;
  }

  /** The amounts each registration serves (current, frozen or persisted), as token inputs. */
  tokenInputs() {
    const out = [];
    for (const r of this.store.list()) {
      if (r.networkId !== this.networkId) continue;
      const w = this.watchers.get(r.id);
      const a = w ? w.snapshot().amounts : null;
      if (!a) continue;
      const totals = new Map();
      for (const [c, v] of a.shielded) if (v > 0n) totals.set(c, v);
      for (const [c, v] of a.unshielded) if (v > 0n) totals.set(`u:${c}`, v);
      out.push({ solanaAddress: r.solanaAddress, totals });
    }
    return out;
  }

  _snapshot(r) {
    if (r.networkId !== this.networkId) {
      return { status: 'error', error: `registered for Midnight network "${r.networkId}"; this service runs on "${this.networkId}"`, lastCheckedAt: null, history: { complete: false, throughHeight: 0 }, unseenCoins: 0, unconfirmedNotes: 0, unreadableEntries: 0, amounts: null };
    }
    const w = this.watchers.get(r.id);
    return w ? w.snapshot() : { status: 'error', error: 'not followed', lastCheckedAt: null, history: { complete: false, throughHeight: 0 }, unseenCoins: 0, unconfirmedNotes: 0, unreadableEntries: 0, amounts: null };
  }

  /** The registration view of I-4 (never a secret: the key's 8-hex public fingerprint only). */
  view(r, byAddress = totalsByAddress(this.getAllInputs())) {
    const s = this._snapshot(r);
    const lookup = this.getLookup();
    const tokens = [];
    const add = (key, amount, privacy, tokenType) => {
      if (amount <= 0n) return;
      const info = tokenInfoFor(key, lookup);
      const addressTotal = (byAddress.get(r.solanaAddress) || new Map()).get(key) || amount;
      tokens.push({
        tokenType,
        privacy,
        mint: deriveKey(`mint:${midnightTokenId(this.networkId, key)}`).toBase58(),
        name: info.name,
        symbol: info.symbol,
        decimals: info.decimals,
        amount: amount.toString(10),
        uiAmountString: uiAmountString(amount, info.decimals),
        clamped: addressTotal > U64_MAX,
      });
    };
    if (s.amounts) {
      for (const [c, v] of [...s.amounts.shielded].sort()) add(c, v, 'shielded', c);
      for (const [c, v] of [...s.amounts.unshielded].sort()) add(`u:${c}`, v, 'unshielded', c);
    }
    const current = r.keys[r.keys.length - 1];
    return {
      id: r.id,
      solanaAddress: r.solanaAddress,
      accountAddress: r.accountAddress,
      networkId: r.networkId,
      keyFingerprint: current.publicKey.slice(0, 8),
      heldKeys: r.keys.length,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      status: s.status,
      error: s.error || null,
      lastCheckedAt: s.lastCheckedAt || null,
      history: { complete: !!s.history.complete, throughHeight: s.history.throughHeight || 0 },
      unseenCoins: s.unseenCoins || 0,
      unconfirmedNotes: s.unconfirmedNotes || 0,
      unreadableEntries: s.unreadableEntries || 0,
      tokens,
    };
  }

  list() {
    const byAddress = totalsByAddress(this.getAllInputs());
    return this.store.list().map((r) => this.view(r, byAddress));
  }

  get(id) {
    const r = this.store.get(id);
    return r ? this.view(r) : null;
  }

  health() {
    const counts = Object.fromEntries([['total', 0], ...STATUSES.map((s) => [s, 0])]);
    for (const r of this.store.list()) {
      counts.total++;
      const st = this._snapshot(r).status;
      counts[st] = (counts[st] || 0) + 1;
    }
    return counts;
  }

  async stop() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this._saveNow();
    }
    const all = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(all.map((w) => w.stop().catch(() => {})));
  }
}

module.exports = { AccountService, createLimit, STATUSES, amountsJson };
