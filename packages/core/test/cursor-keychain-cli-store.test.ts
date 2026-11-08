import assert from 'node:assert/strict';
import test from 'node:test';
import { createSecurityCliCursorKeychainPasswordStore } from '../src/subscription/readers/cursor-keychain-cli-store.js';

test('security CLI store keeps the password out of argv and reads it back', async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  let stored: string | null = null;
  const store = createSecurityCliCursorKeychainPasswordStore(async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === '-i') {
      stored = /-w "((?:[^"\\]|\\.)*)"/.exec(stdin ?? '')![1]!.replace(/\\(.)/g, '$1');
      return '';
    }
    if (args[0] === 'find-generic-password') {
      if (stored === null) throw Object.assign(new Error('not found'), { code: 44 });
      return `${stored}\n`;
    }
    stored = null;
    return '';
  });

  assert.equal(await store.load(), null);
  await store.save('pa"ss\\word');
  assert.equal(await store.load(), 'pa"ss\\word');
  assert.ok(calls.every(({ args }) => !args.some((arg) => arg.includes('pa"ss'))));
  await store.clear();
  assert.equal(await store.load(), null);
});
