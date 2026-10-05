'use strict';
// Indexer actions for a Passport account built from test/fixtures/nm/vectors.json (AA 00059 P2):
// a deposit puts the coin's leaf (its commitment) at a Merkle index; a spend shows its nullifier.

const crypto = require('crypto');
const { zswapOutputEventHex, zswapInputEventHex } = require('./ledger-events');
const V = require('../fixtures/nm/vectors.json');

let eventId = 1000;
const txHash = (label) => crypto.createHash('sha256').update(`aa00059 test tx ${label}`).digest('hex');

function action({ label, height, id, entryPoint, events, start = null, end = null }) {
  const hash = txHash(label);
  return {
    __typename: 'ContractCall',
    entryPoint,
    transaction: {
      hash,
      id,
      block: { height },
      zswapStartIndex: start,
      zswapEndIndex: end,
      transactionResult: { status: 'SUCCESS' },
      zswapLedgerEvents: events(hash).map((raw) => ({ id: eventId++, raw })),
    },
  };
}

/** A deposit of `coin` (a vectors.json coin) into `account` at Merkle index `mtIndex`. */
function deposit(account, coin, { mtIndex, height, id, commitment }) {
  return action({
    label: `deposit ${coin.id} ${mtIndex}`,
    height,
    id,
    entryPoint: 'deposit_shielded',
    start: mtIndex,
    end: mtIndex + 1,
    events: (hash) => [zswapOutputEventHex({ txHash: hash, contract: account, commitment: commitment || coin.commitmentA, mtIndex })],
  });
}

/** A spend of the coin with this nullifier. */
function spend(account, nullifier, { height, id, label = nullifier.slice(0, 8) }) {
  return action({
    label: `spend ${label}`,
    height,
    id,
    entryPoint: 'withdraw_shielded_with_ed25519',
    events: (hash) => [zswapInputEventHex({ txHash: hash, contract: account, nullifier })],
  });
}

const state = (name) => V.states.find((s) => s.name === name);
const coin = (id) => V.coins.find((c) => c.id === id);

/** Account A's deposits of c1..c4 at Merkle indexes 0..3, heights 10..13. */
const depositsAll = (account) => ['c1', 'c2', 'c3', 'c4'].map((c, i) => deposit(account, coin(c), { mtIndex: i, height: 10 + i, id: 100 + i }));

module.exports = { V, state, coin, deposit, spend, depositsAll, txHash };
