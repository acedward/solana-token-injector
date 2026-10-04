'use strict';
// The Midnight indexer, as the account source reads it (AA 00059 P2): the page's own queries
// (web/src/chain/indexer.ts `STATE_QUERY`, web/src/chain/history.ts), over HTTP for queries and the
// `ws` package for the `contractActions` subscription Night Market's history reader opens when an
// account's newest page of actions is full.

const { WebSocket } = require('ws');

const DEFAULT_TIMEOUT_MS = 15_000;

class IndexerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndexerError';
  }
}

/**
 * createIndexerReader({ indexerHttp, indexerWs, nm, timeoutMs?, fetchImpl?, WebSocketImpl? })
 *   graphql(query, variables) -> data            (throws IndexerError)
 *   readAccountState(address) -> {state, blockHeight} | null
 *   historyReader({ pageLimit? }) -> a Night Market AccountHistoryReader (one per account)
 */
function createIndexerReader({ indexerHttp, indexerWs, nm, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
  async function graphql(query, variables) {
    let res;
    try {
      res = await fetchImpl(indexerHttp, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new IndexerError(`the indexer did not answer (${e && e.name === 'TimeoutError' ? 'timeout' : e && e.message ? e.message : e})`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new IndexerError(`the indexer answered HTTP ${res.status} without JSON`);
    }
    if (!res.ok || (body.errors && body.errors.length)) {
      const why = body.errors && body.errors.length ? body.errors.map((e) => e.message).join('; ') : `HTTP ${res.status}`;
      throw new IndexerError(`the indexer refused the query: ${why}`);
    }
    if (!body.data) throw new IndexerError('the indexer answered without data');
    return body.data;
  }

  async function readAccountState(address) {
    const d = await graphql(nm.ACCOUNT_STATE_QUERY, { address });
    if (!d.contract || !d.contract.state) return null;
    return { state: d.contract.state, blockHeight: d.block ? d.block.height : 0 };
  }

  function historyReader({ pageLimit } = {}) {
    return new nm.AccountHistoryReader({
      graphql,
      wsUrl: indexerWs,
      WebSocketImpl,
      ...(pageLimit ? { pageLimit } : {}),
    });
  }

  return { graphql, readAccountState, historyReader };
}

module.exports = { createIndexerReader, IndexerError };
