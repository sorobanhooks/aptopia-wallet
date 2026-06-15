import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAccountNotFound } from '../src/services/account-errors';

test('isAccountNotFound: Horizon 404 (response.status)', () => {
  assert.equal(isAccountNotFound({ response: { status: 404 } }), true);
});

test('isAccountNotFound: response.statusCode 404', () => {
  assert.equal(isAccountNotFound({ response: { statusCode: 404 } }), true);
});

test('isAccountNotFound: NotFoundError name', () => {
  assert.equal(isAccountNotFound({ name: 'NotFoundError' }), true);
});

test('isAccountNotFound: "Not Found" message (stellar-sdk loadAccount)', () => {
  assert.equal(isAccountNotFound(new Error('Not Found')), true);
});

test('isAccountNotFound: unrelated errors are NOT not-found', () => {
  assert.equal(isAccountNotFound(new Error('tx_insufficient_fee')), false);
  assert.equal(isAccountNotFound({ response: { status: 500 } }), false);
  assert.equal(isAccountNotFound(null), false);
  assert.equal(isAccountNotFound(undefined), false);
});
