'use strict';
// The account registration text, v1 (plan I-4, FROZEN at P1): what a Solana wallet signs to show its
// Passport account's balances through this RPC. It authorises nothing on chain; it names this RPC's
// origin, the Midnight network, the wallet, the account and an expiry. Night Market renders it itself
// from this template (plan D10); the injector serves only `registration-info`, never text to sign.
//
//   solana-token-injector account registration v1
//   Show my Midnight account in my Solana wallet
//   RPC {origin}
//   Midnight network {networkId}
//   Wallet {solanaAddress}
//   Account {accountAddress}
//   Expires {YYYY-MM-DD HH:MM:SS} UTC
//   The RPC will see this account's balances.
//   This signature authorises nothing on chain and moves no funds.
//
// Lines joined by one LF (0x0A); no CR; no trailing LF; printable ASCII 0x20-0x7E only; at most 512
// bytes. The first line (45 bytes) can never be the first line of a Passport Ed25519-arm message
// (always "Site: " + a 24-byte label = 30 bytes) or of Night Market's possession envelope (the bare
// label, 1-24 bytes).

const { PublicKey } = require('@solana/web3.js');

const FIRST_LINE = 'solana-token-injector account registration v1';
const PURPOSE_LINE = 'Show my Midnight account in my Solana wallet';
const SEES_LINE = "The RPC will see this account's balances.";
const NOTHING_LINE = 'This signature authorises nothing on chain and moves no funds.';
const FORMAT = FIRST_LINE;
const MAX_BYTES = 512;
const DEFAULT_MAX_TTL_SECONDS = 600;
const LINE_COUNT = 9;

const NETWORK_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ACCOUNT_RE = /^[0-9a-f]{64}$/;
const PRINTABLE_RE = /^[\x20-\x7e]*$/;
const EXPIRES_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

class RegistrationTextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistrationTextError';
  }
}

/** Whether `s` is an origin exactly as WHATWG `new URL(x).origin` serialises it (http or https). */
function isCanonicalOrigin(s) {
  if (typeof s !== 'string' || !s || !PRINTABLE_RE.test(s)) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === s;
}

/** The origin of a public URL (WHATWG serialisation); throws for anything but http(s). */
function originOf(publicUrl) {
  const u = new URL(publicUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RangeError(`the public URL must be http or https, got ${u.protocol}`);
  return u.origin;
}

/** Canonical base58 of a 32-byte key. */
function isCanonicalSolanaAddress(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "YYYY-MM-DD HH:MM:SS" (UTC) of unix seconds. */
function formatExpires(unixSeconds) {
  if (!Number.isSafeInteger(unixSeconds)) throw new RangeError('the expiry must be whole unix seconds');
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  if (y < 1970 || y > 9999) throw new RangeError('the expiry must be in the years 1970..9999');
  return `${String(y).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Unix seconds of "YYYY-MM-DD HH:MM:SS" (UTC), or null when it is not a real date and time. */
function parseExpires(s) {
  const m = EXPIRES_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1970) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  if (!Number.isFinite(ms)) return null;
  const t = ms / 1000;
  // A real date: re-formatting gives the same text (refuses 2026-02-30, 24:00:00, 23:59:60, ...).
  return formatExpires(t) === s ? t : null;
}

function checkFields(f) {
  if (!f || typeof f !== 'object') throw new RangeError('the fields must be an object');
  if (!isCanonicalOrigin(f.origin)) throw new RangeError('origin must be an http(s) origin as new URL(x).origin serialises it');
  if (typeof f.networkId !== 'string' || !NETWORK_RE.test(f.networkId)) throw new RangeError('networkId must match [a-z0-9][a-z0-9-]{0,31}');
  if (!isCanonicalSolanaAddress(f.solanaAddress)) throw new RangeError('solanaAddress must be the canonical base58 of a 32-byte key');
  if (typeof f.accountAddress !== 'string' || !ACCOUNT_RE.test(f.accountAddress)) throw new RangeError('accountAddress must be 64 lowercase hex');
}

/**
 * The exact v1 text for {origin, networkId, solanaAddress, accountAddress, expiresAt} (expiresAt in
 * unix seconds, or a Date with whole seconds). Throws RangeError for a field the template refuses.
 */
function renderRegistrationText(fields) {
  checkFields(fields);
  const t = fields.expiresAt instanceof Date ? fields.expiresAt.getTime() / 1000 : fields.expiresAt;
  const text = [
    FIRST_LINE,
    PURPOSE_LINE,
    `RPC ${fields.origin}`,
    `Midnight network ${fields.networkId}`,
    `Wallet ${fields.solanaAddress}`,
    `Account ${fields.accountAddress}`,
    `Expires ${formatExpires(t)} UTC`,
    SEES_LINE,
    NOTHING_LINE,
  ].join('\n');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new RangeError(`the text would be ${Buffer.byteLength(text)} bytes; at most ${MAX_BYTES}`);
  return text;
}

const take = (line, prefix) => (typeof line === 'string' && line.startsWith(prefix) ? line.slice(prefix.length) : null);

/**
 * Parse a v1 text strictly: the grammar above, then re-rendered from the parsed fields and compared
 * byte for byte. Returns {origin, networkId, solanaAddress, accountAddress, expiresAt}; throws
 * RegistrationTextError (the API's `bad-message`) for anything else.
 */
function parseRegistrationText(text) {
  const fail = (why) => {
    throw new RegistrationTextError(`not a v1 registration text: ${why}`);
  };
  if (typeof text !== 'string') fail('it must be a string');
  if (Buffer.byteLength(text) > MAX_BYTES) fail(`it is longer than ${MAX_BYTES} bytes`);
  if (/[^\x0a\x20-\x7e]/.test(text)) fail('only printable ASCII and LF are allowed');
  const lines = text.split('\n');
  if (lines.length !== LINE_COUNT) fail(`it must have exactly ${LINE_COUNT} lines`);
  if (lines[0] !== FIRST_LINE) fail('the first line is not this format\'s');
  if (lines[1] !== PURPOSE_LINE) fail('line 2 differs');
  if (lines[7] !== SEES_LINE) fail('line 8 differs');
  if (lines[8] !== NOTHING_LINE) fail('line 9 differs');
  const origin = take(lines[2], 'RPC ');
  const networkId = take(lines[3], 'Midnight network ');
  const solanaAddress = take(lines[4], 'Wallet ');
  const accountAddress = take(lines[5], 'Account ');
  const expiresText = take(lines[6], 'Expires ');
  if (origin === null || !isCanonicalOrigin(origin)) fail('the RPC line must carry a canonical http(s) origin');
  if (networkId === null || !NETWORK_RE.test(networkId)) fail('the network line must carry a network id');
  if (solanaAddress === null || !isCanonicalSolanaAddress(solanaAddress)) fail('the Wallet line must carry a canonical base58 address');
  if (accountAddress === null || !ACCOUNT_RE.test(accountAddress)) fail('the Account line must carry 64 lowercase hex');
  if (expiresText === null || !expiresText.endsWith(' UTC')) fail('the Expires line must end with " UTC"');
  const expiresAt = parseExpires(expiresText.slice(0, -' UTC'.length));
  if (expiresAt === null) fail('the Expires line must carry a real date and time');
  const fields = { origin, networkId, solanaAddress, accountAddress, expiresAt };
  let again;
  try {
    again = renderRegistrationText(fields);
  } catch (e) {
    fail(e.message);
  }
  if (again !== text) fail('it does not re-render to the same bytes');
  return fields;
}

/** GET /api/accounts/registration-info. */
function registrationInfo({ origin, networkId, maxTtlSeconds = DEFAULT_MAX_TTL_SECONDS }) {
  return { format: FORMAT, origin, networkId, maxTtlSeconds };
}

module.exports = {
  FIRST_LINE,
  PURPOSE_LINE,
  SEES_LINE,
  NOTHING_LINE,
  FORMAT,
  MAX_BYTES,
  DEFAULT_MAX_TTL_SECONDS,
  NETWORK_RE,
  RegistrationTextError,
  isCanonicalOrigin,
  isCanonicalSolanaAddress,
  originOf,
  formatExpires,
  parseExpires,
  renderRegistrationText,
  parseRegistrationText,
  registrationInfo,
};
