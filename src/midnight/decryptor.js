'use strict';
// Client for the viewing-key decryptor child process (master plan I-1):
// `midnight-esk-decrypt` reads one JSON request per line on stdin and writes
// one JSON response per line on stdout. The client spawns it once, matches
// responses by id, times requests out, restarts the process when it exits
// (exponential backoff) and queues requests while it is down. A request that
// was in flight when the process died is retried once.

const { spawn } = require('child_process');
const readline = require('readline');
const EventEmitter = require('events');
const log = require('../log');

class DecryptError extends Error {}

class DecryptorClient extends EventEmitter {
  constructor({ bin, args = [], env, timeoutMs = 30000, minBackoffMs = 250, maxBackoffMs = 10000, maxRetries = 1 }) {
    super();
    this.bin = bin;
    this.args = args;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.maxRetries = maxRetries;
    this.child = null;
    this.state = 'stopped'; // stopped | starting | running | restarting
    this.seq = 0;
    this.pending = new Map(); // id -> { req, resolve, reject, timer, attempts, sent }
    this.queue = []; // ids waiting for a running process
    this.backoff = minBackoffMs;
    this.restarts = 0;
    this.lastError = null;
    this.info = null; // { version, ledger } from the `version` op
    this.restartTimer = null;
  }

  start() {
    if (this.state !== 'stopped') return this;
    this.stopping = false;
    this._spawn();
    return this;
  }

  _spawn() {
    this.state = 'starting';
    let child;
    try {
      child = spawn(this.bin, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env || process.env });
    } catch (err) {
      this._onExit(null, err);
      return;
    }
    this.child = child;
    let exited = false;
    const onGone = (code, err) => {
      if (exited) return;
      exited = true;
      this._onExit(child, err, code);
    };
    child.on('error', (err) => onGone(null, err));
    child.on('exit', (code, signal) => onGone(code ?? signal));
    child.stdin.on('error', () => {}); // EPIPE when the process died; 'exit' handles it
    child.on('spawn', () => {
      if (this.child !== child) return;
      this.state = 'running';
      this.emit('running');
      this._flush();
      // Ask for the version once per process (shown in /health).
      this.request({ op: 'version' })
        .then((r) => {
          this.info = { version: r.version, ledger: r.ledger };
        })
        .catch(() => {});
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => log.warn(`decryptor: ${line.slice(0, 500)}`));
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn(`decryptor: unparseable output line (${line.length} bytes) ignored`);
      return;
    }
    const p = msg && this.pending.get(msg.id);
    if (!p) return; // late answer for a timed-out request
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    this.backoff = this.minBackoffMs; // the process works: reset the backoff
    p.resolve(msg);
  }

  _onExit(child, err, code) {
    if (child && this.child !== child) return;
    this.child = null;
    this.info = null;
    if (err) this.lastError = err.code === 'ENOENT' ? `decryptor binary not found: ${this.bin}` : err.message;
    else this.lastError = `decryptor exited (${code})`;
    if (this.stopping) {
      this.state = 'stopped';
      return;
    }
    log.warn(`${this.lastError}; restarting in ${this.backoff} ms`);
    // In-flight requests: retry once on the next process, then give up.
    for (const [id, p] of this.pending) {
      if (!p.sent) continue;
      p.sent = false;
      p.attempts++;
      if (p.attempts > this.maxRetries) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`${this.lastError} while handling the request`));
      } else this.queue.push(id);
    }
    this.state = 'restarting';
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.restarts++;
      this._spawn();
    }, delay);
  }

  _flush() {
    if (this.state !== 'running' || !this.child) return;
    const ids = this.queue;
    this.queue = [];
    for (const id of ids) {
      const p = this.pending.get(id);
      if (!p) continue;
      p.sent = true;
      this.child.stdin.write(`${JSON.stringify({ ...p.req, id })}\n`);
    }
  }

  /** Sends one request; resolves with the raw response object ({id, ok, ...}). */
  request(req) {
    if (this.state === 'stopped') return Promise.reject(new Error('decryptor client is stopped'));
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const p = { req, resolve, reject, attempts: 0, sent: false };
      p.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`decryptor timeout after ${this.timeoutMs} ms`));
        // A process that sat on a sent request is presumed stuck: restart it.
        if (p.sent && this.child) {
          log.warn('decryptor did not answer in time; restarting it');
          this.child.kill('SIGKILL');
        }
      }, this.timeoutMs);
      p.timer.unref?.();
      this.pending.set(id, p);
      this.queue.push(id);
      this._flush();
    });
  }

  /** Coins decryptable by the key in a transaction: [{segment, outputIndex, commitment, tokenType, value}]. */
  async decrypt(networkId, viewingKey, raw) {
    const r = await this.request({ op: 'decrypt', networkId, viewingKey, raw });
    if (!r.ok) throw new DecryptError(log.redact(r.error || 'decrypt failed'));
    if (!Array.isArray(r.coins)) throw new DecryptError('decryptor answer has no coins list');
    return r.coins;
  }

  /** { ok: true } or { ok: false, error } — throws only when the decryptor is unreachable. */
  async validateKey(networkId, viewingKey) {
    const r = await this.request({ op: 'validateKey', networkId, viewingKey });
    return r.ok ? { ok: true } : { ok: false, error: log.redact(r.error || 'invalid viewing key') };
  }

  status() {
    return {
      ok: this.state === 'running',
      state: this.state,
      version: this.info && this.info.version,
      ledger: this.info && this.info.ledger,
      restarts: this.restarts,
      pending: this.pending.size,
      lastError: this.lastError,
    };
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('decryptor client stopped'));
    }
    this.pending.clear();
    this.queue = [];
    const child = this.child;
    if (child) {
      await new Promise((resolve) => {
        const t = setTimeout(() => child.kill('SIGKILL'), 2000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        child.stdin.end();
        child.kill('SIGTERM');
      });
    }
    this.state = 'stopped';
    this.child = null;
  }
}

module.exports = { DecryptorClient, DecryptError };
