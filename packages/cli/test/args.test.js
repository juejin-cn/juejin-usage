import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatListenUrl,
  formatSyncSourceList,
  normalizeListenHost,
  parseArgs,
  resolveSyncSource,
} from '../dist/args.js';

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

test('parseArgs reads --source in both forms', () => {
  assert.equal(
    parseArgs(['node', 'jusage', 'sync', '--source', 'claude']).source,
    'claude',
  );
  assert.equal(
    parseArgs(['node', 'jusage', 'sync', '--source=codex']).source,
    'codex',
  );
});

test('resolveSyncSource maps missing/empty/all to full sweep', () => {
  assert.equal(resolveSyncSource(undefined), undefined);
  assert.equal(resolveSyncSource(''), undefined);
  assert.equal(resolveSyncSource('all'), undefined);
});

test('resolveSyncSource normalizes case and aliases', () => {
  assert.equal(resolveSyncSource(' Claude '), 'claude');
  assert.equal(resolveSyncSource('dsh'), 'dsh');
  assert.equal(resolveSyncSource('kilo'), 'kilo-cli');
  assert.equal(resolveSyncSource('qwen-code'), 'qwen');
});

test('resolveSyncSource rejects unknown sources with the valid list', () => {
  assert.throws(() => resolveSyncSource('cluade'), /未知的数据源: cluade/);
  assert.throws(() => resolveSyncSource('cluade'), /claude/);
});

test('help source list comes from the registry and keeps all + dsh', () => {
  const list = formatSyncSourceList();
  assert.ok(list.startsWith('all | '));
  assert.ok(list.includes(' dsh '));
  assert.ok(list.includes('claude'));
});
