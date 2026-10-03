'use strict';
// Registration service: the store (persisted records) + one KeyWatcher per
// distinct viewing key (refcounted across registrations) + the bridge to the
// token manager. Watcher changes schedule a debounced TokenState rebuild;
// API changes (register / delete) rebuild before answering, so the next RPC
// call sees them (FR-107).

const { RegistrationStore } = require('./store');
const { validateRegistration, ValidationError } = require('./validate');
const { KeyWatcher } = require('../midnight/watcher');
const { midnightTokenId, defaultTokenInfo, totalsByAddress } = require('../tokens/midnight');
const { deriveKey } = require('../tokens/accounts');
const { uiAmountString, U64_MAX } = require('../amounts');
const log = require('../log');

class RegistryService {
  /**
   * opts: { midnight (normalized config block), dataDir, decryptor,
   *         onChange (debounced rebuild), onChangeNow (immediate rebuild),
   *         getLookup () -> (tokenType) -> registry info | null,
   *         createWatcher? (for tests) }
   */
  constructor({ midnight, dataDir, decryptor, onChange = () => {}, onChangeNow = () => {}, getLookup = () => () => null, createWatcher }) {
    this.midnight = midnight;
    this.networkId = midnight.networkId;
    this.decryptor = decryptor;
    this.onChange = onChange;
    this.onChangeNow = onChangeNow;
    this.getLookup = getLookup;
    this.store = new RegistrationStore(dataDir);
    this.watchers = new Map(); // viewingKey -> { watcher, refs }
    this.createWatcher =
      createWatcher ||
      ((viewingKey) =>
        new KeyWatcher({
          viewingKey,
          networkId: this.networkId,
          indexerHttp: midnight.indexerHttp,
          indexerWs: midnight.indexerWs,
          decryptor,
          reconnectMinMs: midnight.reconnectMinMs,
          reconnectMaxMs: midnight.reconnectMaxMs,
        }));
  }

  /** Loads the store and starts a watcher per key; totals rebuild from the indexer (Q5). */
  start() {
    this.store.load();
    for (const r of this.store.list()) {
      if (r.networkId === this.networkId) this._acquire(r.viewingKey);
    }
    const n = this.store.list().length;
    if (n) log.line(`registrations: ${n} loaded, ${this.watchers.size} viewing key(s) followed`);
    return this;
  }

  _acquire(viewingKey) {
    const entry = this.watchers.get(viewingKey);
    if (entry) {
      entry.refs++;
      return entry.watcher;
    }
    const watcher = this.createWatcher(viewingKey);
    watcher.on('change', () => this.onChange());
    this.watchers.set(viewingKey, { watcher, refs: 1 });
    watcher.start();
    return watcher;
  }

  _release(viewingKey) {
    const entry = this.watchers.get(viewingKey);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.watchers.delete(viewingKey);
    entry.watcher.stop().catch((err) => log.warn(`watcher stop failed: ${err.message}`));
  }

  /** Validates and stores a registration. Returns { record, created }. Throws ValidationError. */
  async register(body) {
    const { solanaAddress, viewingKey } = await validateRegistration(body, { networkId: this.networkId, decryptor: this.decryptor });
    let res;
    try {
      res = this.store.add({ solanaAddress, viewingKey, networkId: this.networkId });
    } catch (err) {
      log.warn(`registration store write failed: ${err.message}`);
      throw new ValidationError('could not save the registration (storage error)', 500);
    }
    if (res.created) {
      this._acquire(viewingKey);
      this.onChangeNow();
      log.line(`registration ${res.record.id} added: ${solanaAddress} <- ${log.maskKey(viewingKey)}`);
    }
    return res;
  }

  /** Deletes a registration; returns the removed record or null. */
  remove(id) {
    let record;
    try {
      record = this.store.remove(id);
    } catch (err) {
      log.warn(`registration store write failed: ${err.message}`);
      throw new ValidationError('could not delete the registration (storage error)', 500);
    }
    if (!record) return null;
    if (record.networkId === this.networkId) this._release(record.viewingKey);
    this.onChangeNow();
    log.line(`registration ${id} deleted`);
    return record;
  }

  /** Inputs for the token state: one entry per registration on this network. */
  tokenInputs() {
    const out = [];
    for (const r of this.store.list()) {
      const entry = r.networkId === this.networkId && this.watchers.get(r.viewingKey);
      if (entry) out.push({ solanaAddress: r.solanaAddress, totals: entry.watcher.book.totals });
    }
    return out;
  }

  _runtime(r) {
    if (r.networkId !== this.networkId) {
      return { status: 'error', error: `registered for Midnight network "${r.networkId}"; this service runs on "${this.networkId}"`, totals: new Map(), lastEventAt: null };
    }
    const entry = this.watchers.get(r.viewingKey);
    if (!entry) return { status: 'error', error: 'not followed', totals: new Map(), lastEventAt: null };
    return entry.watcher.snapshot();
  }

  /** API view of one registration (never the full key, Q10). */
  view(r, byAddress = totalsByAddress(this.tokenInputs())) {
    const rt = this._runtime(r);
    const lookup = this.getLookup();
    const tokens = [...rt.totals]
      .filter(([, v]) => v > 0n)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tokenType, amount]) => {
        const info = { ...defaultTokenInfo(tokenType), ...(lookup(tokenType) || {}) };
        const addressTotal = (byAddress.get(r.solanaAddress) || new Map()).get(tokenType) || amount;
        return {
          tokenType,
          mint: deriveKey(`mint:${midnightTokenId(this.networkId, tokenType)}`).toBase58(),
          name: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          amount: amount.toString(),
          uiAmountString: uiAmountString(amount, info.decimals),
          clamped: addressTotal > U64_MAX,
        };
      });
    return {
      id: r.id,
      solanaAddress: r.solanaAddress,
      viewingKeyMasked: log.maskKey(r.viewingKey),
      networkId: r.networkId,
      createdAt: r.createdAt,
      status: rt.status,
      error: rt.error || null,
      lastEventAt: rt.lastEventAt || null,
      tokens,
    };
  }

  list() {
    const byAddress = totalsByAddress(this.tokenInputs());
    return this.store.list().map((r) => this.view(r, byAddress));
  }

  get(id) {
    const r = this.store.get(id);
    return r ? this.view(r) : null;
  }

  health() {
    const counts = { total: 0, connecting: 0, syncing: 0, synced: 0, error: 0 };
    for (const r of this.store.list()) {
      counts.total++;
      const s = this._runtime(r).status;
      counts[s] = (counts[s] || 0) + 1;
    }
    counts.viewingKeys = this.watchers.size;
    return counts;
  }

  async stop() {
    const all = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(all.map((e) => e.watcher.stop().catch(() => {})));
  }
}

module.exports = { RegistryService };
