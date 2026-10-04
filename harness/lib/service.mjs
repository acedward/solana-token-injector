// Helpers for talking to the solana-token-injector service (HTTP API + JSON-RPC) from the harness.

import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet) of a byte array. */
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

/** A fresh Solana keypair for the local test network: address + 64-byte secret key in base58 (wallet import format). */
export function newSolanaKeypair() {
  const kp = Keypair.generate();
  return { address: kp.publicKey.toBase58(), secretKeyBase58: base58(kp.secretKey), secretKey: Array.from(kp.secretKey) };
}

/** Synthetic mint of a Midnight token type (spec FR-003): sha256("solana-token-injector:mint:midnight:<net>:<hex>"). */
export function midnightMint(networkId, tokenTypeHex) {
  const id = `midnight:${networkId}:${tokenTypeHex}`;
  return new PublicKey(createHash('sha256').update(`solana-token-injector:mint:${id}`).digest()).toBase58();
}

async function http(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, text, json };
}

export const apiRegister = (serviceUrl, solanaAddress, viewingKey) =>
  http('POST', `${serviceUrl}/api/registrations`, { solanaAddress, viewingKey });
export const apiList = async (serviceUrl) => (await http('GET', `${serviceUrl}/api/registrations`)).json;
export const apiDelete = (serviceUrl, id) => http('DELETE', `${serviceUrl}/api/registrations/${id}`);
export const apiHealth = async (serviceUrl) => (await http('GET', `${serviceUrl}/health`)).json;

/** One JSON-RPC call; returns the raw response text and the parsed body. */
export async function rpcRaw(url, method, params = []) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) };
}

export async function rpcResult(url, method, params = []) {
  const { json } = await rpcRaw(url, method, params);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Token accounts of `owner` under `programId` (jsonParsed), as
 * [{ pubkey, mint, amount (base-unit string), decimals, programOwner }].
 */
export async function tokenAccounts(url, owner, programId) {
  const res = await rpcResult(url, 'getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return res.value.map((v) => ({
    pubkey: v.pubkey,
    mint: v.account.data.parsed.info.mint,
    amount: v.account.data.parsed.info.tokenAmount.amount,
    decimals: v.account.data.parsed.info.tokenAmount.decimals,
    programOwner: v.account.owner,
  }));
}

/**
 * Midnight amounts injected for `owner` (Token-2022), keyed by token type hex.
 * `knownTypes` maps mint -> token type; a Token-2022 account with an unknown mint is reported under `unknown:<mint>`.
 */
export async function injectedAmounts(url, owner, mintToType) {
  const out = {};
  for (const a of await tokenAccounts(url, owner, TOKEN_2022_PROGRAM)) {
    const key = mintToType.get(a.mint) ?? `unknown:${a.mint}`;
    out[key] = a.amount;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Token-2022 TokenMetadata extension of a mint (jsonParsed getAccountInfo through the service). */
export async function mintMetadata(url, mint) {
  const res = await rpcResult(url, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const info = res?.value?.data?.parsed?.info;
  const ext = (info?.extensions ?? []).find((e) => e.extension === 'tokenMetadata');
  return {
    programOwner: res?.value?.owner ?? null,
    decimals: info?.decimals ?? null,
    supply: info?.supply ?? null,
    name: ext?.state?.name ?? null,
    symbol: ext?.state?.symbol ?? null,
    uri: ext?.state?.uri ?? null,
  };
}
