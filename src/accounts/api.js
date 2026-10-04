'use strict';
// The account registration API (AA 00059 P3, interface I-4, FROZEN at P1):
//   GET  /api/accounts/registration-info   {format, origin, networkId, maxTtlSeconds}
//   POST /api/accounts                     201 new / 200 the same or a replaced key; 4xx/5xx {error, code}
//   GET  /api/accounts                     [view]
//   GET  /api/accounts/:id                 view / 404 {error, code: not-found}
// Any other method answers 405 method-not-allowed with `allow` (no DELETE in v1: Q2 C). With the
// account source off, every route answers 503 accounts-disabled. Bodies are at most 16 KiB (a larger
// one closes the connection) and are never logged; the viewing key is never echoed.

const { readBody, sendJson } = require('../server');
const { AccountApiError } = require('./errors');

const MAX_BODY = 16 * 1024;
const ID_RE = /^[0-9a-f]{16}$/;
const NO_STORE = { 'cache-control': 'no-store' };

const sendError = (res, e, headers = {}) => sendJson(res, e.status, e.toJSON(), headers);
const methodNotAllowed = (res, allow) =>
  sendError(res, new AccountApiError('method-not-allowed', `use ${allow.join(' or ')}`), { allow: [...allow, 'OPTIONS'].join(', ') });

/** Returns a route handler (req, res, url) -> true when it answered, false otherwise. */
function createAccountRoutes({ accounts }) {
  return async function accountRoutes(req, res, url) {
    if (url !== '/api/accounts' && !url.startsWith('/api/accounts/')) return false;
    if (!accounts) {
      sendError(res, new AccountApiError('accounts-disabled', 'Passport account registrations are not enabled on this service (midnight.accounts.enabled)'));
      return true;
    }

    if (url === '/api/accounts/registration-info') {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET']), true;
      sendJson(res, 200, accounts.info(), NO_STORE);
      return true;
    }

    if (url === '/api/accounts') {
      if (req.method === 'GET') {
        sendJson(res, 200, accounts.list(), NO_STORE);
        return true;
      }
      if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']), true;
      let body;
      try {
        body = JSON.parse(await readBody(req, MAX_BODY));
      } catch (err) {
        if (err.message === 'body too large') return true; // the socket is destroyed
        sendError(res, new AccountApiError('malformed', 'the body must be JSON: {"solanaAddress", "accountAddress", "accountViewingKey", "message", "signature"}'));
        return true;
      }
      try {
        const { record, created, replacedKey } = await accounts.register(body);
        sendJson(res, created ? 201 : 200, { ...accounts.view(record), created, replacedKey });
      } catch (err) {
        if (err instanceof AccountApiError) sendError(res, err);
        else throw err;
      }
      return true;
    }

    const id = url.slice('/api/accounts/'.length);
    if (id.includes('/')) return false;
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']), true;
    const v = ID_RE.test(id) ? accounts.get(id) : null;
    if (v) sendJson(res, 200, v, NO_STORE);
    else sendError(res, new AccountApiError('not-found', 'no such registration'));
    return true;
  };
}

module.exports = { createAccountRoutes, MAX_BODY };
