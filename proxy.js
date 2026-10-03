#!/usr/bin/env node
'use strict';
/**
 * solana-token-injector
 *
 * A Solana JSON-RPC proxy. Every call is forwarded to a real upstream RPC,
 * except the handful a wallet uses to discover and display SPL tokens. Those
 * get extra, synthetic accounts merged in so a token defined in config.json
 * appears in the wallet as if it existed on chain.
 *
 * Display only: the token's accounts do not exist upstream, so any
 * transaction that touches them will fail simulation.
 *
 * Usage: node proxy.js [config.json]
 * The code lives in src/ (see src/app.js for how the pieces fit).
 */

const { main } = require('./src/app');

main(process.argv[2]).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
