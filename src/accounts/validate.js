'use strict';
// Account registration checks, in the frozen order of plan I-4 (FROZEN at P1). The first failure
// answers; nothing is read from the chain before step 12 and nothing is stored here at all (step 17,
// the store, is the service's). Steps 1-11 are pure; steps 12-16 take an injected chain reader, so
// the API plugs in the indexer and the tests a mock.
//
//  1 body: a JSON object with the five string fields                          malformed            400
//  2 solanaAddress: canonical base58 of 32 bytes, a strict Ed25519 key       bad-solana-address   400
//  3 accountAddress: 64 hex                                                   bad-account-address  400
//  4 accountViewingKey: 64 hex                                                bad-viewing-key      400
//  5 signature: 128 hex                                                       malformed            400
//  6 message: the v1 template, re-rendered to the same bytes                 bad-message          400
//  7 its Wallet and Account equal the body's                                 message-mismatch     400
//  8 its RPC equals this injector's origin                                   wrong-origin         400
//  9 its Midnight network equals this injector's                             wrong-network        400
// 10 now < Expires <= now + maxTtlSeconds                                     expired / expiry-too-far 400
// 11 strict Ed25519 signature over the text's bytes by solanaAddress         bad-signature        401
// 12 the indexer has a contract at accountAddress                            indexer-unavailable 503 / account-not-found 404
// 13 a Passport account: pinned verifier keys exactly, authority retired, booted   not-passport-account 403
// 14 its network salt is keccak256("midnight:" || networkId)                 wrong-network        400
// 15 devices holds the wallet's entry at k = auth_nonce, else some k in 0..255 not-a-device       403
// 16 X25519 public key of accountViewingKey = enc_key                         enc-key-mismatch     403
//
// The viewing key never appears in an error message.

const { PublicKey } = require('@solana/web3.js');

const { AccountApiError } = require('./errors');
const { parseRegistrationText, RegistrationTextError } = require('./message');

const FIELDS = ['solanaAddress', 'accountAddress', 'accountViewingKey', 'message', 'signature'];
const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX128 = /^[0-9a-fA-F]{128}$/;

const fail = (code, message, detail) => {
  throw new AccountApiError(code, message, detail);
};
const hexOf = (b) => Buffer.from(b).toString('hex');

/**
 * Steps 1-11. ctx: {origin, networkId, maxTtlSeconds, now() -> unix seconds, nm: {isStrictEd25519Key,
 * verifyEd25519Strict}, trace?(step)}. Returns the checked request; throws AccountApiError.
 */
function checkRequest(body, ctx) {
  const trace = ctx.trace || (() => {});
  trace(1);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('malformed', 'the body must be a JSON object');
  for (const f of FIELDS) if (typeof body[f] !== 'string') fail('malformed', `"${f}" must be a string`);

  trace(2);
  let walletHex;
  try {
    const pk = new PublicKey(body.solanaAddress);
    if (pk.toBase58() !== body.solanaAddress) throw new Error('not canonical');
    walletHex = hexOf(pk.toBytes());
  } catch {
    fail('bad-solana-address', 'solanaAddress must be the canonical base58 of a 32-byte Ed25519 public key');
  }
  if (!ctx.nm.isStrictEd25519Key(walletHex)) fail('bad-solana-address', 'solanaAddress is not a usable Ed25519 key (identity, small order or not canonical)');

  trace(3);
  if (!HEX64.test(body.accountAddress)) fail('bad-account-address', 'accountAddress must be 64 hex characters (no 0x)');
  const accountAddress = body.accountAddress.toLowerCase();

  trace(4);
  if (!HEX64.test(body.accountViewingKey)) fail('bad-viewing-key', 'accountViewingKey must be 64 hex characters (the account\'s X25519 inbox secret)');
  const viewingKey = body.accountViewingKey.toLowerCase();

  trace(5);
  if (!HEX128.test(body.signature)) fail('malformed', 'signature must be 128 hex characters (64 bytes)');

  trace(6);
  let text;
  try {
    text = parseRegistrationText(body.message);
  } catch (e) {
    if (e instanceof RegistrationTextError) fail('bad-message', e.message);
    throw e;
  }

  trace(7);
  if (text.solanaAddress !== body.solanaAddress || text.accountAddress !== accountAddress) {
    fail('message-mismatch', 'the signed text names another wallet or account than the body');
  }

  trace(8);
  if (text.origin !== ctx.origin) fail('wrong-origin', `the signed text is for ${text.origin}, not this RPC (${ctx.origin})`);

  trace(9);
  if (text.networkId !== ctx.networkId) fail('wrong-network', `the signed text is for Midnight network ${text.networkId}, not ${ctx.networkId}`);

  trace(10);
  const now = ctx.now();
  if (text.expiresAt <= now) fail('expired', 'the signed text has expired');
  if (text.expiresAt > now + ctx.maxTtlSeconds) fail('expiry-too-far', `the signed text expires more than ${ctx.maxTtlSeconds} s from now`);

  trace(11);
  const ok = ctx.nm.verifyEd25519Strict(walletHex, new Uint8Array(Buffer.from(body.message, 'utf8')), new Uint8Array(Buffer.from(body.signature, 'hex')));
  if (!ok) fail('bad-signature', 'the signature does not verify for this wallet and text');

  return { solanaAddress: body.solanaAddress, walletHex, accountAddress, viewingKey, text };
}

/**
 * Steps 12-16. ctx: {networkId, nm (the vendored bundle), pinnedKeys (circuit -> digest),
 * chain: {readAccountState(address) -> Promise<{state, blockHeight} | null>}, trace?(step)}.
 * Returns {decoded, useCounter, encPublicKey, blockHeight}; throws AccountApiError.
 */
async function checkAccountOnChain(req, ctx) {
  const trace = ctx.trace || (() => {});
  const nm = ctx.nm;
  trace(12);
  let read;
  try {
    read = await ctx.chain.readAccountState(req.accountAddress);
  } catch {
    fail('indexer-unavailable', 'the Midnight indexer did not answer; try again');
  }
  if (!read || !read.state) fail('account-not-found', 'the Midnight indexer knows no contract at this address');

  trace(13);
  let d;
  try {
    d = nm.decodeAccountState(req.accountAddress, read.state);
  } catch (e) {
    fail('not-passport-account', 'this contract is not a Passport account', e && e.message ? e.message : 'its state does not decode');
  }
  const keys = nm.compareVerifierKeys(d.operations, ctx.pinnedKeys);
  if (!keys.equal) {
    const parts = [
      keys.different.length ? `different: ${keys.different.join(', ')}` : '',
      keys.missing.length ? `missing: ${keys.missing.join(', ')}` : '',
      keys.extra.length ? `extra: ${keys.extra.join(', ')}` : '',
    ].filter(Boolean);
    fail('not-passport-account', 'this contract is not a Night Market Passport account (its circuits or verifier keys differ from the pinned set)', `verifier-keys: ${parts.join('; ')}`);
  }
  if (!(d.authority.committee === 0 && d.authority.threshold >= 1)) {
    fail('not-passport-account', 'this account\'s maintenance authority is not retired', `authority-live: committee ${d.authority.committee}, threshold ${d.authority.threshold}`);
  }
  if (!d.view.booted) fail('not-passport-account', 'this account is not activated', 'not-booted');

  trace(14);
  if (d.view.networkSalt.toLowerCase() !== nm.networkSaltFor(ctx.networkId)) {
    fail('wrong-network', `this account is set up for another Midnight network than ${ctx.networkId}`);
  }

  trace(15);
  const account = new Uint8Array(Buffer.from(req.accountAddress, 'hex'));
  const epoch = BigInt(d.view.deviceEpoch);
  const device = nm.ed25519DeviceForKey(req.walletHex);
  const entryAt = (k) => hexOf(device.entryAt(account, epoch, k));
  const live = d.view.devices.map((x) => x.toLowerCase());
  const nonce = BigInt(d.view.authNonce);
  let useCounter = live.includes(entryAt(nonce)) ? nonce : null;
  if (useCounter === null) useCounter = nm.findUseCounter(live, entryAt, 0n, nm.DEVICE_SCAN_LIMIT);
  if (useCounter === null) fail('not-a-device', 'this wallet is not the account\'s device');

  trace(16);
  const encPublicKey = nm.encPublicKeyOf(req.viewingKey);
  if (encPublicKey !== d.view.encKey.toLowerCase()) fail('enc-key-mismatch', 'the viewing key does not match the account\'s current encryption key');

  return { decoded: d, useCounter, encPublicKey, blockHeight: read.blockHeight };
}

/** Steps 1-16. */
async function validateRegistration(body, ctx) {
  const req = checkRequest(body, ctx);
  const chain = await checkAccountOnChain(req, ctx);
  return { ...req, ...chain };
}

module.exports = { FIELDS, checkRequest, checkAccountOnChain, validateRegistration };
