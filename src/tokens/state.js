'use strict';
// TokenState: every synthetic account the RPC layer merges into answers,
// built from a list of token specs. A state is immutable once built; callers
// swap the whole object to change what is injected (atomic for each request).
//
// Token spec:
//   { id, name, symbol, decimals, program: 'token' | 'token-2022',
//     uri? | image?, description?,
//     holders: [[solanaAddress, baseUnits (bigint)], ...] }

const { PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { tokenAmount, clampU64, U64_MAX } = require('../amounts');
const {
  MPL_TOKEN_METADATA,
  deriveKey,
  encodeMint,
  encodeTokenAccount,
  encodeMetaplexMetadata,
  metaplexPda,
} = require('./accounts');

function emptyState() {
  return {
    accounts: new Map(), // pubkey -> { owner, data, parsed, isTokenAccount }
    byOwner: new Map(), // wallet -> [token account pubkeys]
    mints: new Map(), // mint -> token summary
    tokenAccounts: new Map(), // token account pubkey -> { mint, amount, decimals }
    metadataJson: new Map(), // id -> JSON served at /token-metadata/<id>.json
    ids: new Map(), // token id -> mint pubkey
  };
}

const metadataUri = (publicUrl, id) => `${publicUrl}/token-metadata/${encodeURIComponent(id)}.json`;

/**
 * Adds one token to `state`. Throws (without touching `state`) when the spec
 * cannot be encoded, so a bad token never leaves half its accounts behind.
 */
function addToken(state, t, { publicUrl }) {
  const { id, name, symbol } = t;
  const decimals = t.decimals ?? 6;
  const is2022 = t.program === 'token-2022';
  const programId = is2022 ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;
  const programName = is2022 ? 'spl-token-2022' : 'spl-token';

  const mint = deriveKey(`mint:${id}`);
  const authority = deriveKey(`authority:${id}`);
  const uri = t.uri || metadataUri(publicUrl, id);

  const pending = { accounts: [], owners: [], tokenAccounts: [] };

  // Token accounts, one ATA per wallet.
  let supply = 0n;
  let clamped = false;
  const holders = [];
  for (const [wallet, raw] of t.holders) {
    const owner = new PublicKey(wallet);
    const c = clampU64(raw);
    clamped = clamped || c.clamped;
    const amount = c.amount;
    supply += amount;
    const ata = spl.getAssociatedTokenAddressSync(mint, owner, false, programId);
    const data = encodeTokenAccount({ mint, owner, amount, is2022 });
    const info = {
      isNative: false,
      mint: mint.toBase58(),
      owner: owner.toBase58(),
      state: 'initialized',
      tokenAmount: tokenAmount(amount, decimals),
    };
    if (is2022) info.extensions = [{ extension: 'immutableOwner' }];
    pending.accounts.push([
      ata.toBase58(),
      {
        owner: programId.toBase58(),
        data,
        parsed: { program: programName, parsed: { info, type: 'account' }, space: data.length },
        isTokenAccount: true,
      },
    ]);
    pending.tokenAccounts.push([ata.toBase58(), { mint: mint.toBase58(), amount, decimals }]);
    pending.owners.push([owner.toBase58(), ata.toBase58()]);
    holders.push({ address: ata.toBase58(), owner: owner.toBase58(), amount, clamped: c.clamped });
  }
  if (supply > U64_MAX) {
    supply = U64_MAX;
    clamped = true;
  }

  // Mint.
  const mintData = encodeMint({ supply, decimals, is2022, mint, authority, name, symbol, uri });
  const mintInfo = { decimals, freezeAuthority: null, isInitialized: true, mintAuthority: null, supply: supply.toString() };
  if (is2022) {
    mintInfo.extensions = [
      { extension: 'metadataPointer', state: { authority: authority.toBase58(), metadataAddress: mint.toBase58() } },
      {
        extension: 'tokenMetadata',
        state: {
          additionalMetadata: [],
          mint: mint.toBase58(),
          name,
          symbol,
          updateAuthority: authority.toBase58(),
          uri,
        },
      },
    ];
  }
  pending.accounts.push([
    mint.toBase58(),
    {
      owner: programId.toBase58(),
      data: mintData,
      parsed: { program: programName, parsed: { info: mintInfo, type: 'mint' }, space: mintData.length },
    },
  ]);

  // Metaplex metadata PDA (most wallets look here for name/symbol/logo, for both token programs).
  const metadataPda = metaplexPda(mint);
  pending.accounts.push([
    metadataPda.toBase58(),
    {
      owner: MPL_TOKEN_METADATA.toBase58(),
      data: encodeMetaplexMetadata({ authority, mint, name, symbol, uri }),
      parsed: null,
    },
  ]);

  // Everything encoded: commit.
  for (const [k, v] of pending.accounts) state.accounts.set(k, v);
  for (const [k, v] of pending.tokenAccounts) state.tokenAccounts.set(k, v);
  for (const [owner, ata] of pending.owners) {
    const list = state.byOwner.get(owner) || [];
    list.push(ata);
    state.byOwner.set(owner, list);
  }
  if (!t.uri) {
    state.metadataJson.set(id, { name, symbol, description: t.description || '', image: t.image || '' });
  }
  state.ids.set(id, mint.toBase58());
  state.mints.set(mint.toBase58(), {
    id,
    name,
    symbol,
    decimals,
    supply,
    clamped,
    source: t.source || 'static',
    programId: programId.toBase58(),
    metadataPda: metadataPda.toBase58(),
    uri,
    holders: holders.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)),
  });
}

/**
 * Builds a TokenState from specs. A spec that fails to encode is skipped and
 * reported through `onError(spec, err)` (default: throw).
 */
function buildTokenState(specs, { publicUrl, onError } = {}) {
  const state = emptyState();
  for (const t of specs) {
    try {
      if (state.ids.has(t.id)) throw new Error(`duplicate token id "${t.id}"`);
      addToken(state, t, { publicUrl });
    } catch (err) {
      if (!onError) throw err;
      onError(t, err);
    }
  }
  return state;
}

module.exports = { buildTokenState, emptyState, metadataUri };
