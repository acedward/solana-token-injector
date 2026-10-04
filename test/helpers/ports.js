'use strict';
// Random free TCP ports >= 10000 on 127.0.0.1 (shared machine: never fixed ports).

const net = require('net');

function isFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

const taken = new Set(); // ports handed out by this process

/** A free port p (and p+1 .. p+span-1 also free), p in [10000, 60000). */
async function freePort(span = 1) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const p = 10000 + Math.floor(Math.random() * (50000 - span));
    let ok = true;
    for (let i = 0; i < span && ok; i++) ok = !taken.has(p + i) && (await isFree(p + i));
    if (ok) {
      for (let i = 0; i < span; i++) taken.add(p + i);
      return p;
    }
  }
  throw new Error('no free port found');
}

module.exports = { freePort, isFree };
