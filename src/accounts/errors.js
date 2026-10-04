'use strict';
// The account registration API's error codes and HTTP statuses (plan I-4, FROZEN at P1). Every error
// answer is {"error": "<message>", "code": "<code>"} (plus "detail" for not-passport-account).

const CODES = Object.freeze({
  malformed: 400,
  'bad-solana-address': 400,
  'bad-account-address': 400,
  'bad-viewing-key': 400,
  'bad-message': 400,
  'message-mismatch': 400,
  'wrong-origin': 400,
  'wrong-network': 400,
  expired: 400,
  'expiry-too-far': 400,
  'bad-signature': 401,
  'not-passport-account': 403,
  'not-a-device': 403,
  'enc-key-mismatch': 403,
  'account-not-found': 404,
  'not-found': 404,
  'method-not-allowed': 405,
  'storage-error': 500,
  'indexer-unavailable': 503,
  'accounts-disabled': 503,
});

class AccountApiError extends Error {
  constructor(code, message, detail) {
    if (!(code in CODES)) throw new Error(`unknown account API error code ${code}`);
    super(message);
    this.name = 'AccountApiError';
    this.code = code;
    this.status = CODES[code];
    if (detail !== undefined) this.detail = detail;
  }

  toJSON() {
    return { error: this.message, code: this.code, ...(this.detail !== undefined ? { detail: this.detail } : {}) };
  }
}

module.exports = { CODES, AccountApiError };
