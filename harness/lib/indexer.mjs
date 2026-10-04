// Indexer v4 viewing-key session: `connect` (HTTP mutation) + `shieldedTransactions` (graphql-ws).
// Query text = the 2.x wallet SDK's (midnight-wallet packages/indexer-client/src/graphql/subscriptions/ShieldedTransactions.ts).

import { createClient } from 'graphql-ws';
import WebSocket from 'ws';

export const CONNECT = 'mutation Connect($viewingKey: ViewingKey!) { connect(viewingKey: $viewingKey) }';
export const DISCONNECT = 'mutation Disconnect($sessionId: HexEncoded!) { disconnect(sessionId: $sessionId) }';

export const SHIELDED_TRANSACTIONS = `subscription ShieldedTransactions($sessionId: HexEncoded!, $index: Int) {
  shieldedTransactions(sessionId: $sessionId, index: $index) {
    __typename
    ... on ShieldedTransactionsProgress { highestEndIndex highestCheckedEndIndex highestRelevantEndIndex }
    ... on RelevantTransaction {
      transaction { id raw hash protocolVersion identifiers startIndex endIndex
        fees { paidFees estimatedFees }
        transactionResult { status segments { id success } } }
      collapsedMerkleTree { startIndex endIndex update protocolVersion }
    }
  }
}`;

export async function gql(httpUrl, query, variables) {
  const r = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(`indexer: ${j.errors.map((e) => e.message).join('; ')}`);
  return j.data;
}

export const connect = async (httpUrl, viewingKey) => (await gql(httpUrl, CONNECT, { viewingKey })).connect;
export const disconnect = (httpUrl, sessionId) => gql(httpUrl, DISCONNECT, { sessionId }).catch(() => {});

/**
 * Collect every RelevantTransaction for `viewingKey` from index 0 until the session has caught up,
 * then resolve `{ sessionId, transactions, progress }`.
 *
 * "Caught up" needs care (indexer 4.4.0-rc.1, indexer-api/src/infra/storage/transaction.rs:554-597 and
 * api/progress_cache.rs): `highestCheckedEndIndex` is the MAX over ALL wallets, not this one, and
 * progress values are cached per wallet for up to 5 s. Right after the FIRST connect of a key the
 * wallet-indexer has not scanned it yet, so progress can say checked == highest with relevant 0 while
 * relevant transactions are still to come. So we finish only on a progress event received after
 * `minMs` (> cache TTL + wallet-indexer poll delay) that is consistent:
 * checked >= highest and relevant == the highest end index delivered (0 when none).
 */
export async function captureShieldedTransactions({ indexerHttp, indexerWs, viewingKey, timeoutMs = 180_000, minMs = 12_000, settleMs = 2000, log = () => {} }) {
  const sessionId = await connect(indexerHttp, viewingKey);
  const client = createClient({ url: indexerWs, webSocketImpl: WebSocket, lazy: true, retryAttempts: 0 });
  const transactions = [];
  const progress = [];
  let lastEndIndex = 0;
  const t0 = Date.now();
  try {
    await new Promise((resolve, reject) => {
      let caughtUpAt = null;
      const timer = setTimeout(() => {
        dispose();
        reject(new Error(`shieldedTransactions: not caught up after ${timeoutMs} ms (last progress ${JSON.stringify(progress.at(-1))})`));
      }, timeoutMs);
      let settleTimer = null;
      const finish = () => {
        clearTimeout(timer);
        dispose();
        resolve();
      };
      const dispose = client.subscribe(
        { query: SHIELDED_TRANSACTIONS, variables: { sessionId, index: 0 } },
        {
          next: ({ data, errors }) => {
            if (errors?.length) {
              clearTimeout(timer);
              dispose();
              reject(new Error(errors.map((e) => e.message).join('; ')));
              return;
            }
            const ev = data.shieldedTransactions;
            if (ev.__typename === 'RelevantTransaction') {
              transactions.push(ev);
              lastEndIndex = Math.max(lastEndIndex, ev.transaction.endIndex);
              log(`[fixtures] relevant tx ${ev.transaction.hash} [${ev.transaction.startIndex}, ${ev.transaction.endIndex})`);
            } else {
              progress.push(ev);
              log(`[fixtures] progress ${JSON.stringify(ev)}`);
              const caughtUp =
                Date.now() - t0 >= minMs &&
                ev.highestEndIndex > 0 &&
                ev.highestCheckedEndIndex >= ev.highestEndIndex &&
                ev.highestRelevantEndIndex === lastEndIndex;
              if (caughtUp && !caughtUpAt) {
                caughtUpAt = Date.now();
                // Keep listening briefly so in-flight relevant transactions are not cut off.
                settleTimer = setTimeout(finish, settleMs);
              } else if (!caughtUp && settleTimer) {
                clearTimeout(settleTimer);
                settleTimer = null;
                caughtUpAt = null;
              }
            }
          },
          error: (e) => {
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(JSON.stringify(e?.reason ?? e)));
          },
          complete: () => {},
        },
      );
    });
  } finally {
    await client.dispose();
    await disconnect(indexerHttp, sessionId);
  }
  return { sessionId, transactions, progress };
}
