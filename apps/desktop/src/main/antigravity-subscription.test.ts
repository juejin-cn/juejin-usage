import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCustomAntigravityConfiguration, parseGoogleCredentials } from './antigravity-subscription';

test('reads only the official Google OAuth access token metadata', () => {
  assert.deepEqual(parseGoogleCredentials({ access_token: 'official-session-token', expiry_date: 1_900_000_000 }), {
    accessToken: 'official-session-token', expiresAt: 1_900_000_000_000,
  });
  assert.equal(parseGoogleCredentials({ refresh_token: 'not-an-access-token' }), null);
});

test('marks explicit API-key or endpoint overrides as custom Antigravity configuration', () => {
  assert.equal(hasCustomAntigravityConfiguration({}), false);
  assert.equal(hasCustomAntigravityConfiguration({ GEMINI_API_KEY: 'custom-key' }), true);
  assert.equal(hasCustomAntigravityConfiguration({ ANTIGRAVITY_BASE_URL: 'https://proxy.example.com' }), true);
});
