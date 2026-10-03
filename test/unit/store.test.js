'use strict';
// C.4: registration store (atomic JSON file, idempotent ids) and coin book.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { RegistrationStore, registrationId, FILE } = require('../../src/registry/store');
const { CoinBook } = require('../../src/midnight/coins');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sti-store-'));
const A = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const KEY = 'mn_shield-esk_undeployed1dlyj7u8juj68fd4psnkqhjxh32sec0q480vzswg8kd485e2kljcs9ete5h';
const KEY2 = 'mn_shield-esk_undeployed1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sqqqqqq';

test('id = first 16 hex of sha256(address + ":" + key)', () => {
  const want = crypto.createHash('sha256').update(`${A}:${KEY}`).digest('hex').slice(0, 16);
  assert.equal(registrationId(A, KEY), want);
  assert.match(want, /^[0-9a-f]{16}$/);
});

test('add / persist / reload / remove; same pair twice is one record', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data');
  const s = new RegistrationStore(data).load();
  assert.equal(s.list().length, 0, 'missing file = empty');

  const a = s.add({ solanaAddress: A, viewingKey: KEY, networkId: 'undeployed', now: new Date('2026-10-03T00:00:00Z') });
  assert.equal(a.created, true);
  assert.equal(a.record.createdAt, '2026-10-03T00:00:00.000Z');
  const again = s.add({ solanaAddress: A, viewingKey: KEY, networkId: 'undeployed' });
  assert.equal(again.created, false);
  assert.equal(again.record.id, a.record.id);
  s.add({ solanaAddress: A, viewingKey: KEY2, networkId: 'undeployed' });
  assert.equal(s.list().length, 2);

  const file = path.join(data, FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'file is private to the owner');
  assert.equal(fs.statSync(data).mode & 0o777, 0o700, 'data dir is private to the owner');
  assert.deepEqual(fs.readdirSync(data), [FILE], 'no temp files left behind');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.registrations.length, 2);

  const reloaded = new RegistrationStore(data).load();
  assert.deepEqual(reloaded.list(), s.list());

  assert.equal(reloaded.remove(a.record.id).id, a.record.id);
  assert.equal(reloaded.remove(a.record.id), null);
  assert.equal(new RegistrationStore(data).load().list().length, 1, 'removal persisted');
});

test('a corrupt file is an error and is never overwritten', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, FILE), '{"registrations": [');
  assert.throws(() => new RegistrationStore(dir).load(), /not valid JSON.*never overwritten/);
  assert.equal(fs.readFileSync(path.join(dir, FILE), 'utf8'), '{"registrations": [');
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ registrations: [{ id: 'x', solanaAddress: A, viewingKey: KEY, networkId: 'n', createdAt: 'c' }] }));
  assert.throws(() => new RegistrationStore(dir).load(), /id does not match/);
});

test('a failed write leaves memory and disk unchanged', { skip: process.getuid && process.getuid() === 0 ? 'root ignores directory permissions' : false }, (t) => {
  const dir = tmp();
  t.after(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const s = new RegistrationStore(dir).load();
  s.add({ solanaAddress: A, viewingKey: KEY, networkId: 'undeployed' });
  fs.chmodSync(dir, 0o500); // read-only dir: the temp file cannot be created
  assert.throws(() => s.add({ solanaAddress: A, viewingKey: KEY2, networkId: 'undeployed' }));
  assert.equal(s.list().length, 1);
  assert.equal(new RegistrationStore(dir).load().list().length, 1);
});

test('coin book: dedupe by commitment, totals per type (u128)', () => {
  const b = new CoinBook();
  const T = 'ab'.repeat(32);
  const c = (n) => n.toString(16).padStart(64, '0');
  assert.equal(b.add({ commitment: c(1), tokenType: T, value: '100' }), true);
  assert.equal(b.add({ commitment: c(1), tokenType: T, value: '100' }), false, 'duplicate delivery ignored');
  assert.equal(b.add({ commitment: c(2).toUpperCase(), tokenType: T.toUpperCase(), value: '340282366920938463463374607431768211455' }), true);
  assert.equal(b.totals.get(T), 100n + 340282366920938463463374607431768211455n);
  assert.equal(b.size, 2);
  assert.throws(() => b.add({ commitment: 'zz', tokenType: T, value: '1' }), /bad commitment/);
  assert.throws(() => b.add({ commitment: c(3), tokenType: T, value: '-1' }), /bad value/);
});
