'use strict';
// The real Solana RPC behind the proxy, plus a short-lived cache of the last
// response context (slot) used for locally answered calls.

const JSONbig = require('json-bigint')({ useNativeBigInt: true });

function createUpstream(url) {
  async function post(bodyText, { timeoutMs } = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: bodyText,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    return { status: res.status, text: await res.text() };
  }

  let cachedCtx = null;
  let cachedAt = 0;

  function rememberContext(result) {
    if (result && typeof result === 'object' && result.context && result.context.slot !== undefined) {
      cachedCtx = result.context;
      cachedAt = Date.now();
    }
  }

  async function currentContext() {
    if (cachedCtx && Date.now() - cachedAt < 1000) return cachedCtx;
    try {
      const { text } = await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }));
      const slot = JSONbig.parse(text).result;
      cachedCtx = { ...(cachedCtx || {}), slot };
      cachedAt = Date.now();
    } catch {
      cachedCtx = cachedCtx || { slot: 0 };
    }
    return cachedCtx;
  }

  return { url, post, rememberContext, currentContext };
}

module.exports = { createUpstream };
