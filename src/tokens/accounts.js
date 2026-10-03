'use strict';
// Binary encoders for the synthetic accounts: SPL mint (Token or Token-2022
// with MetadataPointer + TokenMetadata), token account (Token-2022 adds
// ImmutableOwner) and the Metaplex Token Metadata v1 account.

const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const { pack: packTokenMetadata } = require('@solana/spl-token-metadata');

const MPL_TOKEN_METADATA = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const METAPLEX_METADATA_SIZE = 679;

/** Fake addresses are sha256 hashes, so they can never collide with a real mint (FR-003). */
function deriveKey(label) {
  return new PublicKey(crypto.createHash('sha256').update(`solana-token-injector:${label}`).digest());
}

function tlv(type, value) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(value.length, 2);
  return Buffer.concat([header, value]);
}

function encodeMint({ supply, decimals, is2022, mint, authority, name, symbol, uri }) {
  const base = Buffer.alloc(spl.MINT_SIZE);
  spl.MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    base,
  );
  if (!is2022) return base;

  // Token-2022: base mint padded to 165 bytes, account-type byte, then TLV extensions.
  const padded = Buffer.alloc(spl.ACCOUNT_SIZE);
  base.copy(padded);
  const pointer = Buffer.concat([authority.toBuffer(), mint.toBuffer()]);
  const metadata = Buffer.from(
    packTokenMetadata({ updateAuthority: authority, mint, name, symbol, uri, additionalMetadata: [] }),
  );
  return Buffer.concat([
    padded,
    Buffer.from([spl.AccountType.Mint]),
    tlv(spl.ExtensionType.MetadataPointer, pointer),
    tlv(spl.ExtensionType.TokenMetadata, metadata),
  ]);
}

function encodeTokenAccount({ mint, owner, amount, is2022 }) {
  const base = Buffer.alloc(spl.ACCOUNT_SIZE);
  spl.AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: spl.AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    base,
  );
  if (!is2022) return base;
  // Associated token accounts under Token-2022 carry the ImmutableOwner extension.
  return Buffer.concat([base, Buffer.from([spl.AccountType.Account]), tlv(spl.ExtensionType.ImmutableOwner, Buffer.alloc(0))]);
}

/** Metaplex Token Metadata v1 account (strings padded to their max length, as Metaplex does). */
function encodeMetaplexMetadata({ authority, mint, name, symbol, uri }) {
  const str = (s, max, field) => {
    const bytes = Buffer.from(s, 'utf8');
    if (bytes.length > max) throw new Error(`${field} "${s}" is longer than ${max} bytes`);
    const out = Buffer.alloc(4 + max);
    out.writeUInt32LE(max, 0);
    bytes.copy(out, 4);
    return out;
  };
  const body = Buffer.concat([
    Buffer.from([4]), // Key::MetadataV1
    authority.toBuffer(),
    mint.toBuffer(),
    str(name, 32, 'name'),
    str(symbol, 10, 'symbol'),
    str(uri, 200, 'uri'),
    Buffer.from([0, 0]), // seller_fee_basis_points
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // primary_sale_happened
    Buffer.from([1]), // is_mutable
    Buffer.from([0]), // edition_nonce: None
    Buffer.from([1, 2]), // token_standard: Some(Fungible)
    Buffer.from([0, 0, 0, 0]), // collection, uses, collection_details, programmable_config: None
  ]);
  const out = Buffer.alloc(METAPLEX_METADATA_SIZE);
  body.copy(out);
  return out;
}

function metaplexPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA,
  )[0];
}

module.exports = {
  MPL_TOKEN_METADATA,
  METAPLEX_METADATA_SIZE,
  deriveKey,
  tlv,
  encodeMint,
  encodeTokenAccount,
  encodeMetaplexMetadata,
  metaplexPda,
};
