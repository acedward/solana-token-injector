'use strict';
// Holds the current TokenState and rebuilds it when its inputs change.
// Inputs: static specs (config.json) and a provider of Midnight specs
// (registrations). Rebuilds are debounced (default 100 ms) and swap the
// state object atomically: a request planned before the swap keeps the old
// state, the next one sees the new state.

const log = require('../log');
const { buildTokenState } = require('./state');

function createTokenManager({ publicUrl, staticSpecs = [], midnightSpecs = () => [], debounceMs = 100 }) {
  let statics = staticSpecs;
  let state = build();
  let timer = null;
  let waiters = [];
  let version = 1;

  function build() {
    const specs = [...statics, ...midnightSpecs()];
    return buildTokenState(specs, {
      publicUrl,
      onError: (spec, err) => log.warn(`token "${spec.id}" skipped: ${err.message}`),
    });
  }

  function rebuildNow() {
    if (timer) clearTimeout(timer);
    timer = null;
    try {
      state = build();
      version++;
    } catch (err) {
      log.warn(`token state rebuild failed, keeping the previous one: ${err.message}`);
    }
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  }

  /** Schedule a rebuild (debounced). */
  function invalidate() {
    if (timer) return;
    timer = setTimeout(rebuildNow, debounceMs);
    timer.unref?.();
  }

  /** Resolves once no rebuild is pending. */
  function settled() {
    if (!timer) return Promise.resolve();
    return new Promise((r) => waiters.push(r));
  }

  function setStaticSpecs(specs) {
    statics = specs;
    invalidate();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    getState: () => state,
    getVersion: () => version,
    setStaticSpecs,
    invalidate,
    rebuildNow,
    settled,
    stop,
  };
}

module.exports = { createTokenManager };
