import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { decryptZcodeCredential, extractBillingPlan } from './zcode-subscription';

function encrypt(plain: string, secret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `enc:v1:${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

test('decrypts ZCode credentials only with the current device secret', () => {
  const encrypted = encrypt('zcode-jwt', 'current-device-secret');
  assert.equal(decryptZcodeCredential(encrypted, 'current-device-secret'), 'zcode-jwt');
  assert.equal(decryptZcodeCredential(encrypted, 'other-device-secret'), null);
});

test('maps an active ZCode billing tier without exposing plan payload', () => {
  assert.equal(extractBillingPlan({
    data: { plans: [{ status: 'active', plan_id: 'zai-pro-monthly' }] },
  }), 'Pro');
  assert.equal(extractBillingPlan({ data: { plans: [] } }), null);
});
