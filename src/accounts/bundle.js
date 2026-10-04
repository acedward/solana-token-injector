'use strict';
// The vendored Night Market slice (vendor/night-market/night-market-core.mjs, plan D1 / I-V): an ESM
// bundle of the page's own coin logic, loaded once from this CommonJS service with import() (D2).

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const BUNDLE = path.join(__dirname, '..', '..', 'vendor', 'night-market', 'night-market-core.mjs');

let loading = null;

/** The bundle's exports (a promise, cached). Rejects with a clear message when it cannot load. */
function loadNightMarket(file = BUNDLE) {
  if (file !== BUNDLE) return load(file);
  loading ??= load(file).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function load(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`the vendored Night Market bundle is missing: ${file} (rebuild it with vendor/night-market/build.sh)`);
  }
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    throw new Error(`the vendored Night Market bundle does not load: ${e && e.message ? e.message : e}`);
  }
}

module.exports = { loadNightMarket, BUNDLE };
