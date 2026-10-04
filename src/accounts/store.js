'use strict';
// Account registration store (AA 00059 P2, plan D4/D5/D8): <dataDir>/accounts.json, separate from the
// viewing-key registrations (registrations.json is never touched). Written atomically (temp file +
// fsync + rename), file 0600, dir 0700, like src/registry/store.js. A corrupt file stops the start and
// is never overwritten.
//
// Record (format v1):
//   { id, solanaAddress, accountAddress, networkId,
//     keys: [{ secret, publicKey, addedAt }],      // the key ring (D5), the current key LAST
//     createdAt, updatedAt,
//     lastAmounts: { shielded: {<hex>: "<base units>"}, unshielded: {<hex>: "<base units>"} } | null,
//     lastAmountsAt: ISO | null }                  // D8: served on error / stale-key, also after a restart
// id = first 16 hex of sha256("account:" + solanaAddress + ":" + accountAddress).
// v1 keeps the X25519 secrets in plaintext at rest (as 00056 Q10 does for viewing keys).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'accounts.json';
const FORMAT_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;

function accountRegistrationId(solanaAddress, accountAddress) {
  return crypto.createHash('sha256').update(`account:${solanaAddress}:${accountAddress}`).digest('hex').slice(0, 16);
}

function checkAmounts(a, where) {
  if (a === null || a === undefined) return null;
  if (typeof a !== 'object') throw new Error(`${where}: lastAmounts must be an object`);
  const out = { shielded: {}, unshielded: {} };
  for (const k of ['shielded', 'unshielded']) {
    for (const [c, v] of Object.entries(a[k] || {})) {
      if (!HEX64.test(c) || !/^\d+$/.test(String(v))) throw new Error(`${where}: lastAmounts.${k} must map 64 hex to base units`);
      out[k][c] = String(v);
    }
  }
  return out;
}

function checkRecord(r, i) {
  const where = `account ${i}`;
  for (const f of ['id', 'solanaAddress', 'accountAddress', 'networkId', 'createdAt', 'updatedAt']) {
    if (typeof r[f] !== 'string' || !r[f]) throw new Error(`${where}: missing "${f}"`);
  }
  if (!HEX64.test(r.accountAddress)) throw new Error(`${where}: accountAddress must be 64 lowercase hex`);
  if (accountRegistrationId(r.solanaAddress, r.accountAddress) !== r.id) throw new Error(`${where}: id does not match its wallet and account`);
  if (!Array.isArray(r.keys) || r.keys.length === 0) throw new Error(`${where}: keys must be a non-empty list`);
  for (const k of r.keys) {
    if (!k || !HEX64.test(k.secret) || !HEX64.test(k.publicKey) || typeof k.addedAt !== 'string') throw new Error(`${where}: a key must be {secret, publicKey, addedAt} (64 hex)`);
  }
  return {
    id: r.id,
    solanaAddress: r.solanaAddress,
    accountAddress: r.accountAddress,
    networkId: r.networkId,
    keys: r.keys.map((k) => ({ secret: k.secret, publicKey: k.publicKey, addedAt: k.addedAt })),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastAmounts: checkAmounts(r.lastAmounts, where),
    lastAmountsAt: typeof r.lastAmountsAt === 'string' ? r.lastAmountsAt : null,
  };
}

class AccountStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, FILE);
    this.records = new Map();
  }

  /** Loads the file (missing = no registrations). A corrupt file throws and is never overwritten. */
  load() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return this;
      throw e;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(`${this.file} is not valid JSON (${e.message}); fix or move it away, it is never overwritten`);
    }
    if (!raw || raw.version !== FORMAT_VERSION || !Array.isArray(raw.accounts)) {
      throw new Error(`${this.file}: expected {"version": 1, "accounts": [...]}; fix or move it away, it is never overwritten`);
    }
    const records = new Map();
    raw.accounts.forEach((r, i) => {
      let rec;
      try {
        rec = checkRecord(r, i);
      } catch (e) {
        throw new Error(`${this.file}: ${e.message}; fix or move it away, it is never overwritten`);
      }
      records.set(rec.id, rec);
    });
    this.records = records;
    this.loaded = true;
    return this;
  }

  save() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ version: FORMAT_VERSION, accounts: [...this.records.values()] }, null, 2)}\n`;
    const tmp = path.join(this.dataDir, `.${FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  list() {
    return [...this.records.values()];
  }

  get(id) {
    return this.records.get(id) || null;
  }

  /**
   * Registers (wallet, account) with a key (idempotent; D5). Returns
   * { record, created, replacedKey }: a new pair -> created; the current key again -> neither; another
   * key -> it becomes current (kept or added to the ring) and replacedKey. Persists before returning;
   * on a write failure the memory is restored and the error rethrown.
   */
  upsert({ solanaAddress, accountAddress, networkId, secret, publicKey, now = new Date() }) {
    const id = accountRegistrationId(solanaAddress, accountAddress);
    const at = now.toISOString();
    const existing = this.records.get(id);
    if (!existing) {
      const record = {
        id,
        solanaAddress,
        accountAddress,
        networkId,
        keys: [{ secret, publicKey, addedAt: at }],
        createdAt: at,
        updatedAt: at,
        lastAmounts: null,
        lastAmountsAt: null,
      };
      this.records.set(id, record);
      try {
        this.save();
      } catch (e) {
        this.records.delete(id);
        throw e;
      }
      return { record, created: true, replacedKey: false };
    }
    const current = existing.keys[existing.keys.length - 1];
    if (current.publicKey === publicKey) return { record: existing, created: false, replacedKey: false };
    const before = { keys: existing.keys, updatedAt: existing.updatedAt, networkId: existing.networkId };
    const held = existing.keys.find((k) => k.publicKey === publicKey);
    existing.keys = [...existing.keys.filter((k) => k.publicKey !== publicKey), held || { secret, publicKey, addedAt: at }];
    existing.updatedAt = at;
    existing.networkId = networkId;
    try {
      this.save();
    } catch (e) {
      Object.assign(existing, before);
      throw e;
    }
    return { record: existing, created: false, replacedKey: true };
  }

  /** Records the amounts being served (D8); persisted by the caller's next save(). */
  setAmounts(id, amounts, at = new Date()) {
    const r = this.records.get(id);
    if (!r) return;
    r.lastAmounts = amounts;
    r.lastAmountsAt = at.toISOString();
  }
}

module.exports = { AccountStore, accountRegistrationId, FILE };
