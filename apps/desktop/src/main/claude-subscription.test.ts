import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyClaudeAuthStatus,
  hasCustomClaudeConfiguration,
  parseClaudeCredentials,
} from './claude-subscription';

test('accepts only a logged-in first-party OAuth account', () => {
  assert.equal(classifyClaudeAuthStatus({
    loggedIn: true,
    authMethod: 'oauth_token',
    apiProvider: 'firstParty',
  }), 'official');
  assert.equal(classifyClaudeAuthStatus({ loggedIn: false }), 'not-signed-in');
  assert.equal(classifyClaudeAuthStatus({
    loggedIn: true,
    authMethod: 'api_key',
    apiProvider: 'firstParty',
  }), 'custom-provider');
  assert.equal(classifyClaudeAuthStatus({
    loggedIn: true,
    authMethod: 'oauth_token',
    apiProvider: 'bedrock',
  }), 'custom-provider');
  assert.equal(classifyClaudeAuthStatus({}), null);
});

test('detects custom API, base URL, helper, and cloud-provider settings', () => {
  assert.equal(hasCustomClaudeConfiguration({ ANTHROPIC_API_KEY: 'sk-test' }), true);
  assert.equal(hasCustomClaudeConfiguration({ ANTHROPIC_BASE_URL: 'https://example.test' }), true);
  assert.equal(hasCustomClaudeConfiguration({}, [{ apiKeyHelper: '/bin/helper' }]), true);
  assert.equal(hasCustomClaudeConfiguration({}, [{ env: { CLAUDE_CODE_USE_VERTEX: '1' } }]), true);
  assert.equal(hasCustomClaudeConfiguration({ CLAUDE_CODE_USE_BEDROCK: 'false' }), false);
  assert.equal(hasCustomClaudeConfiguration({}, [{ env: {} }]), false);
});

test('parses only the Claude OAuth credential subset and normalizes expiry', () => {
  assert.deepEqual(parseClaudeCredentials(JSON.stringify({
    claudeAiOauth: {
      accessToken: 'secret-token',
      refreshToken: 'ignored-refresh-token',
      expiresAt: 1_800_000_000,
      subscriptionType: 'max_5x',
    },
  })), {
    accessToken: 'secret-token',
    expiresAt: 1_800_000_000_000,
    planLabel: 'Max 5x',
  });
  assert.equal(parseClaudeCredentials('{broken'), null);
  assert.equal(parseClaudeCredentials({ claudeAiOauth: {} }), null);
});
