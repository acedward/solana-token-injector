'use strict';
// Registration store (Q5): one JSON file, <dataDir>/registrations.json,
// written atomically (temp file + fsync + rename), loaded on start.
// v1 keeps viewing keys in plaintext at rest (Q10); the file is mode 0600
// and the data dir 0700.
//
// Record: { id, solanaAddress, viewingKey, networkId, createdAt }
// id = first 16 hex of sha256(solanaAddress + ":" + viewingKey) (Q12: idempotent).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'registrations.json';
const FORMAT_VERSION = 1;

function registrationId(solanaAddress, viewingKey) {
  return crypto.createHash('sha256').update(`${solanaAddress}:${viewingKey}`).digest('hex').slice(0, 16);
}

function checkRecord(r, i) {
  const fields = ['id', 'solanaAddress', 'viewingKey', 'networkId', 'createdAt'];
  for (const f of fields) {
    if (typeof r[f] !== 'string' || !r[f]) throw new Error(`record ${i}: missing "${f}"`);
  }
  if (registrationId(r.solanaAddress, r.viewingKey) !== r.id) throw new Error(`record ${i}: id does not match its address and key`);
}

class RegistrationStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, FILE);
    this.records = new Map(); // id -> record, insertion order = creation order
  }

  /** Loads the file (missing file = no registrations). A corrupt file is an error: it is never overwritten. */
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
    const list = Array.isArray(raw) ? raw : raw && raw.registrations;
    if (!Array.isArray(list)) throw new Error(`${this.file}: expected {"registrations": [...]}`);
    const records = new Map();
    list.forEach((r, i) => {
      try {
        checkRecord(r, i);
      } catch (e) {
        throw new Error(`${this.file}: ${e.message}`);
      }
      records.set(r.id, {
        id: r.id,
        solanaAddress: r.solanaAddress,
        viewingKey: r.viewingKey,
        networkId: r.networkId,
        createdAt: r.createdAt,
      });
    });
    this.records = records;
    return this;
  }

  /** Atomic write: temp file in the same dir, fsync, rename over the old file. */
  save() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: FORMAT_VERSION, registrations: [...this.records.values()] }, null, 2) + '\n';
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

  /** Adds a registration (idempotent). Returns { record, created }. Persists before returning. */
  add({ solanaAddress, viewingKey, networkId, now = new Date() }) {
    const id = registrationId(solanaAddress, viewingKey);
    const existing = this.records.get(id);
    if (existing) return { record: existing, created: false };
    const record = { id, solanaAddress, viewingKey, networkId, createdAt: now.toISOString() };
    this.records.set(id, record);
    try {
      this.save();
    } catch (e) {
      this.records.delete(id);
      throw e;
    }
    return { record, created: true };
  }

  /** Removes a registration. Returns the removed record or null. Persists before returning. */
  remove(id) {
    const record = this.records.get(id);
    if (!record) return null;
    this.records.delete(id);
    try {
      this.save();
    } catch (e) {
      this.records.set(id, record);
      throw e;
    }
    return record;
  }
}

module.exports = { RegistrationStore, registrationId, FILE };
