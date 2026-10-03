'use strict';
// Which decrypted outputs count toward a registration's total (FR-105, Q19):
//   FAILURE                      -> nothing
//   SUCCESS                      -> every segment (the indexer sends segments: null)
//   PARTIAL_SUCCESS              -> segment 0 (guaranteed) + fallible segments listed with success: true
// Mirrors the indexer's own accounting (midnight-indexer v2.0.0-rc.4,
// indexer-common/src/domain/ledger/ledger_state.rs:1238-1280). Transient
// outputs never reach this point: the decryptor reports only `outputs` (I-1).

function segmentCounts(transactionResult, segment) {
  const status = transactionResult && transactionResult.status;
  if (status === 'SUCCESS') return true;
  if (status === 'PARTIAL_SUCCESS') {
    if (segment === 0) return true;
    const s = (transactionResult.segments || []).find((x) => Number(x.id) === segment);
    return !!(s && s.success === true);
  }
  return false; // FAILURE, or a malformed / missing result
}

/** Filters decryptor coins by the transaction's result. */
function countableCoins(coins, transactionResult) {
  return coins.filter((c) => segmentCounts(transactionResult, Number(c.segment)));
}

/**
 * Sync state from a ShieldedTransactionsProgress event. Reads the deprecated
 * names the 2.x wallet SDK query selects, or the newer *Zswap* names.
 * Missing numbers -> "syncing".
 */
function progressSynced(p) {
  if (!p) return false;
  const highest = p.highestEndIndex ?? p.highestZswapEndIndex;
  const checked = p.highestCheckedEndIndex ?? p.highestCheckedZswapEndIndex;
  if (typeof highest !== 'number' || typeof checked !== 'number') return false;
  return checked >= highest;
}

module.exports = { segmentCounts, countableCoins, progressSynced };
