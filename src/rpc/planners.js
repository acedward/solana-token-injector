'use strict';
// Per-method plans. plan(req) returns PASS (forward untouched), { local(ctx) }
// (answer here), or { patch(result, ctx) } (forward, then merge fake data into
// the result). Each plan reads the TokenState current at planning time, so a
// request sees one consistent state even if it is swapped meanwhile.

const { tokenAmount } = require('../amounts');
const { uiAccount, keyedAccount, matchesFilters } = require('./encoding');

const PASS = Symbol('pass');

const withCtx = (ctx, value) => ({ context: ctx, value });

const planners = {
  getAccountInfo(fake, [pubkey, cfg]) {
    if (!fake.accounts.has(pubkey)) return PASS;
    return { local: (ctx) => withCtx(ctx, uiAccount(fake.accounts.get(pubkey), cfg)) };
  },

  getMultipleAccounts(fake, [pubkeys, cfg]) {
    if (!Array.isArray(pubkeys) || !pubkeys.some((k) => fake.accounts.has(k))) return PASS;
    return {
      patch(result) {
        pubkeys.forEach((k, i) => {
          if (fake.accounts.has(k)) result.value[i] = uiAccount(fake.accounts.get(k), cfg);
        });
        return result;
      },
    };
  },

  getTokenAccountsByOwner(fake, [owner, filter = {}, cfg]) {
    const mine = fake.byOwner.get(owner);
    if (filter.mint && fake.mints.has(filter.mint)) {
      // Upstream would reject an unknown mint, so answer entirely here.
      const keys = (mine || []).filter((k) => fake.tokenAccounts.get(k).mint === filter.mint);
      return { local: (ctx) => withCtx(ctx, keys.map((k) => keyedAccount(fake, k, cfg))) };
    }
    if (!mine) return PASS;
    const extra = mine.filter((k) => filter.programId && fake.accounts.get(k).owner === filter.programId);
    if (extra.length === 0) return PASS;
    return {
      patch(result) {
        result.value.push(...extra.map((k) => keyedAccount(fake, k, cfg)));
        return result;
      },
    };
  },

  getProgramAccounts(fake, [programId, cfg = {}]) {
    const extra = [...fake.accounts.keys()].filter((k) => {
      const a = fake.accounts.get(k);
      return a.owner === programId && matchesFilters(a, cfg.filters);
    });
    if (extra.length === 0) return PASS;
    return {
      patch(result) {
        const list = Array.isArray(result) ? result : result.value;
        list.push(...extra.map((k) => keyedAccount(fake, k, cfg)));
        return result;
      },
    };
  },

  getTokenAccountBalance(fake, [pubkey]) {
    const ta = fake.tokenAccounts.get(pubkey);
    if (!ta) return PASS;
    return { local: (ctx) => withCtx(ctx, tokenAmount(ta.amount, ta.decimals)) };
  },

  getTokenSupply(fake, [mint]) {
    const m = fake.mints.get(mint);
    if (!m) return PASS;
    return { local: (ctx) => withCtx(ctx, tokenAmount(m.supply, m.decimals)) };
  },

  getTokenLargestAccounts(fake, [mint]) {
    const m = fake.mints.get(mint);
    if (!m) return PASS;
    return {
      local: (ctx) =>
        withCtx(
          ctx,
          m.holders.slice(0, 20).map((h) => ({ address: h.address, ...tokenAmount(h.amount, m.decimals) })),
        ),
    };
  },
};

/** Returns plan(req) bound to a TokenState getter. */
function createPlanner(getState) {
  return function plan(req) {
    const p = planners[req && req.method];
    if (!p) return PASS;
    try {
      return p(getState(), Array.isArray(req.params) ? req.params : []);
    } catch {
      return PASS; // malformed params: let upstream produce the proper error
    }
  };
}

module.exports = { PASS, createPlanner };
