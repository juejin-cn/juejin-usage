import assert from 'node:assert/strict';
import test from 'node:test';

import { formatListenUrl, normalizeListenHost, parseArgs } from '../dist/args.js';

test('parseArgs reads --host and --port without defaulting them', () => {
  const parsed = parseArgs(['node', 'jusage', 'start', '--host', '0.0.0.0', '--port', '9000']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.port, 9000);
});

test('parseArgs accepts --host= form and IPv6', () => {
  const parsed = parseArgs(['node', 'jusage', 'start', '--host=::1']);
  assert.equal(parsed.host, '::1');
  assert.equal(parsed.port, undefined);
});

test('parseArgs leaves host/port unset when omitted', () => {
  const parsed = parseArgs(['node', 'jusage', 'start']);
  assert.equal(parsed.host, undefined);
  assert.equal(parsed.port, undefined);
});

test('jusage --host 0.0.0.0 is treated as start', () => {
  const parsed = parseArgs(['node', 'jusage', '--host', '0.0.0.0']);
  assert.equal(parsed.command, 'start');
  assert.equal(parsed.host, '0.0.0.0');
});

test('service start keeps --host', () => {
  const parsed = parseArgs(['node', 'jusage', 'service', 'start', '--host', '0.0.0.0']);
  assert.equal(parsed.command, 'service');
  assert.equal(parsed.serviceAction, 'start');
  assert.equal(parsed.host, '0.0.0.0');
});

test('normalizeListenHost rejects empty or path-like values', () => {
  assert.equal(normalizeListenHost(' 0.0.0.0 '), '0.0.0.0');
  assert.throws(() => normalizeListenHost(''), /不能为空/);
  assert.throws(() => normalizeListenHost('0.0.0.0/foo'), /无效/);
});

test('parseArgs throws when --host has no value', () => {
  assert.throws(() => parseArgs(['node', 'jusage', 'start', '--host']), /需要地址/);
});

test('formatListenUrl maps wildcard bind to loopback', () => {
  assert.equal(formatListenUrl('0.0.0.0', 8452), 'http://127.0.0.1:8452');
  assert.equal(formatListenUrl('::1', 8452), 'http://[::1]:8452');
});
