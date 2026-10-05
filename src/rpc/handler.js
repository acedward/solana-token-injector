'use strict';
// JSON-RPC request handling: single requests we don't touch are piped
// through byte for byte; everything else is planned, forwarded in one
// upstream batch with internal ids, patched or answered locally, and returned
// with the client's ids and order (FR-001, FR-004, FR-006).

const JSONbig = require('json-bigint')({ useNativeBigInt: true });
const log = require('../log');
const { PASS } = require('./planners');

function createRpcHandler({ plan, upstream }) {
  return async function handleRpc(bodyText) {
    let parsed;
    try {
      parsed = JSONbig.parse(bodyText);
    } catch {
      return upstream.post(bodyText); // not JSON: upstream returns the parse error
    }

    const isBatch = Array.isArray(parsed);
    const reqs = isBatch ? parsed : [parsed];
    const plans = reqs.map(plan);

    // AA 00059 P7.1: a single request that may need a metadata fill-in is forwarded byte for byte, and
    // its answer is returned untouched unless the account the upstream says does not exist is filled in.
    if (!isBatch && plans[0] !== PASS && plans[0].onlyIfNull) {
      const up = await upstream.post(bodyText);
      let upParsed;
      try {
        upParsed = JSONbig.parse(up.text);
      } catch {
        return up;
      }
      const result = upParsed && upParsed.result;
      const patched = result !== undefined && result !== null ? plans[0].patch(result) : null;
      if (!patched) {
        log.method(parsed, 'pass');
        return up;
      }
      upstream.rememberContext(patched);
      log.method(parsed, 'patched');
      return { status: up.status, text: JSONbig.stringify({ ...upParsed, result: patched }) };
    }

    // Fast path: a single request we don't touch is piped straight through.
    if (!isBatch && plans[0] === PASS) {
      log.method(parsed, 'pass');
      const up = await upstream.post(bodyText);
      if (log.isVerbose() && (up.status !== 200 || up.text.includes('"error"'))) log.line(`  upstream HTTP ${up.status}  ${up.text.slice(0, 200)}`);
      return up;
    }

    // Forward everything that isn't answered locally, in one upstream batch,
    // with internal ids so responses can be matched back regardless of order.
    const forwardIdx = reqs.map((_, i) => i).filter((i) => !plans[i] || !plans[i].local);
    const responses = new Array(reqs.length);
    if (forwardIdx.length) {
      const upBody = JSONbig.stringify(forwardIdx.map((i) => ({ ...reqs[i], id: i })));
      const up = await upstream.post(upBody);
      let upParsed;
      try {
        upParsed = JSONbig.parse(up.text);
      } catch {
        return up; // upstream sent something odd (rate-limit page, etc.): hand it back as-is
      }
      if (!Array.isArray(upParsed)) {
        if (!isBatch) return up; // single request answered with an error object
        upParsed = forwardIdx.map((i) => ({ ...upParsed, id: i }));
      }
      for (const r of upParsed) {
        const i = Number(r.id);
        if (log.isVerbose() && r.error) log.line(`  upstream error for ${reqs[i] && reqs[i].method}: ${JSONbig.stringify(r.error).slice(0, 200)}`);
        upstream.rememberContext(r.result);
        const p = plans[i];
        if (p !== PASS && p.patch && r.result !== undefined && r.result !== null) {
          try {
            const out = p.patch(r.result);
            if (out !== null && out !== undefined) {
              r.result = out;
              log.method(reqs[i], 'patched');
            } else log.method(reqs[i], 'pass');
          } catch {
            log.method(reqs[i], 'pass');
          }
        } else {
          log.method(reqs[i], 'pass');
        }
        responses[i] = { ...r, id: reqs[i].id };
      }
    }

    const localIdx = reqs.map((_, i) => i).filter((i) => plans[i] && plans[i].local);
    if (localIdx.length) {
      const ctx = await upstream.currentContext();
      for (const i of localIdx) {
        responses[i] = { jsonrpc: '2.0', id: reqs[i].id, result: plans[i].local(ctx) };
        log.method(reqs[i], 'local');
      }
    }

    const out = isBatch ? responses.filter(Boolean) : responses[0];
    return { status: 200, text: JSONbig.stringify(out) };
  };
}

module.exports = { createRpcHandler };
