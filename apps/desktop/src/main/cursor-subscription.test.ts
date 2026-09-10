import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCursorSessionCookie, extractCursorUserId } from './cursor-subscription';

function jwt(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('extracts the Cursor user id from common JWT subjects', () => {
  assert.equal(extractCursorUserId(jwt({ sub: 'auth0|user_abc123' })), 'user_abc123');
  assert.equal(extractCursorUserId(jwt({ sub: 'google-oauth2|person-id' })), 'google-oauth2|person-id');
  assert.equal(extractCursorUserId('invalid'), null);
});

test('encodes the Cursor dashboard session cookie', () => {
  assert.equal(
    buildCursorSessionCookie('auth0|user', 'a.b-c_d'),
    'WorkosCursorSessionToken=auth0|user%3A%3Aa.b-c_d',
  );
});
