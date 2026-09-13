import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCustomKimiConfiguration, parseKimiCredentials } from './kimi-subscription';

test('parses only the Kimi Code OAuth fields needed for quota', () => {
  assert.deepEqual(parseKimiCredentials({
    access_token: 'access-token',
    refresh_token: 'must-not-be-exposed',
    expires_at: 1_900_000_000,
  }), {
    accessToken: 'access-token',
    expiresAt: 1_900_000_000_000,
  });
  assert.equal(parseKimiCredentials({ access_token: '' }), null);
});

test('accepts only the official Kimi Code API domains', () => {
  assert.equal(hasCustomKimiConfiguration({}), false);
  assert.equal(hasCustomKimiConfiguration({ KIMI_CODE_BASE_URL: 'https://api.kimi.ai/coding/v1/' }), false);
  assert.equal(hasCustomKimiConfiguration({ KIMI_CODE_BASE_URL: 'https://proxy.example/v1' }), true);
});
