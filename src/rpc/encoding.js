'use strict';
// Account encodings for RPC answers (jsonParsed, base64, base58, legacy
// binary, base64+zstd, dataSlice) and program-account filters.

const zlib = require('zlib');
const bs58 = require('bs58').default || require('bs58');
const { U64_MAX } = require('../amounts');

function rentExemptLamports(len) {
  return (128 + len) * 6960; // 3480 lamports/byte-year * 2 years
}

function encodeData(acct, encoding, dataSlice) {
  if (encoding === 'jsonParsed' && acct.parsed && !dataSlice) return acct.parsed;
  let data = acct.data;
  if (dataSlice) data = data.subarray(dataSlice.offset, dataSlice.offset + dataSlice.length);
  switch (encoding) {
    case undefined:
    case 'binary':
      return bs58.encode(data); // legacy default: bare base58 string
    case 'base58':
      return [bs58.encode(data), 'base58'];
    case 'base64+zstd':
      if (zlib.zstdCompressSync) return [zlib.zstdCompressSync(data).toString('base64'), 'base64+zstd'];
      return [data.toString('base64'), 'base64'];
    default: // base64, or jsonParsed for accounts without a parser
      return [data.toString('base64'), 'base64'];
  }
}

function uiAccount(acct, cfg = {}) {
  return {
    data: encodeData(acct, cfg.encoding, cfg.dataSlice),
    executable: false,
    lamports: rentExemptLamports(acct.data.length),
    owner: acct.owner,
    rentEpoch: U64_MAX, // rentEpoch reported for rent-exempt accounts
    space: acct.data.length,
  };
}

function keyedAccount(state, pubkey, cfg) {
  return { pubkey, account: uiAccount(state.accounts.get(pubkey), cfg) };
}

function matchesFilters(acct, filters = []) {
  for (const f of filters) {
    if (f.dataSize !== undefined && acct.data.length !== Number(f.dataSize)) return false;
    if (f.memcmp) {
      const { offset, bytes, encoding } = f.memcmp;
      const want = encoding === 'base64' ? Buffer.from(bytes, 'base64') : Buffer.from(bs58.decode(bytes));
      const o = Number(offset);
      if (!acct.data.subarray(o, o + want.length).equals(want)) return false;
    }
    if (f.tokenAccountState !== undefined && !acct.isTokenAccount) return false;
  }
  return true;
}

module.exports = { rentExemptLamports, encodeData, uiAccount, keyedAccount, matchesFilters };
