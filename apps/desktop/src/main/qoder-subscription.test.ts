import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQoderAppLoginStatus, parseQoderCredentials } from './qoder-subscription';

test('accepts an official Qoder session token but ignores unrelated nested values', () => {
  assert.deepEqual(parseQoderCredentials({ auth: { security_oauth_token: 'official-qoder-session-token' } }), {
    token: 'official-qoder-session-token',
  });
  assert.equal(parseQoderCredentials('encrypted-qoder-local-auth-state'), null);
  assert.equal(parseQoderCredentials({ apiKey: 'custom-provider-key' }), null);
});

test('reads only explicit login state from the Qoder app status file', () => {
  assert.equal(parseQoderAppLoginStatus({ logged_in: true }), true);
  assert.equal(parseQoderAppLoginStatus({ loggedIn: false }), false);
  assert.equal(parseQoderAppLoginStatus({ logged_in: 'true' }), null);
  assert.equal(parseQoderAppLoginStatus({ status: 'ready' }), null);
});
