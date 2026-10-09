import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import path from 'node:path';
import { prependGuiNodePaths } from './cli-runtime';
import { readCodexSubscription, resolveCodexLaunch } from './codex-subscription';

test('discovers both macOS bundled CLI layouts without a shell PATH or override', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const originalOverride = process.env.CODEX_CLI_PATH;
  delete process.env.CODEX_CLI_PATH;
  t.after(() => {
    if (originalOverride === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalOverride;
  });
  for (const root of ['/Applications', path.join(process.env.HOME ?? '', 'Applications')]) {
    for (const appName of ['ChatGPT.app', 'Codex.app']) {
      for (const relative of ['codex', 'codex-cli/CodexCLI.app/Contents/MacOS/codex']) {
        const bundled = path.join(root, appName, 'Contents', 'Resources', relative);
        await t.test(bundled, (subtest) => {
          subtest.mock.method(fs, 'existsSync', (candidate: fs.PathLike) => candidate === bundled);
          assert.deepEqual(resolveCodexLaunch(), {
            command: bundled, args: ['app-server', '--listen', 'stdio://'],
          });
        });
      }
    }
  }
  await t.test('retains standalone CLI priority', (subtest) => {
    subtest.mock.method(fs, 'existsSync', (candidate: fs.PathLike) =>
      candidate === '/opt/homebrew/bin/codex'
      || candidate === '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
    assert.deepEqual(resolveCodexLaunch(), {
      command: '/opt/homebrew/bin/codex', args: ['app-server', '--stdio'],
    });
  });
  await t.test('retains explicit override priority', (subtest) => {
    process.env.CODEX_CLI_PATH = '/custom/codex';
    subtest.mock.method(fs, 'existsSync', () => true);
    assert.deepEqual(resolveCodexLaunch(), {
      command: '/custom/codex', args: ['app-server', '--stdio'],
    });
  });
});

function mockCodex(t: TestContext) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: t.mock.fn(() => true),
  });
  const requests: { id?: number; method: string }[] = [];
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) requests.push(JSON.parse(line));
  });
  // Every launch is intercepted, so tests cannot execute the user's Codex CLI.
  t.mock.method(childProcess, 'spawn', () => child as unknown as childProcess.ChildProcessWithoutNullStreams);
  const respond = (id: number, result: unknown) => child.stdout.write(`${JSON.stringify({ id, result })}\n`);
  return { child, requests, respond };
}

function assertCliRecoveryHint(message: string | null) {
  assert.match(message ?? '', /codex --version/);
  assert.match(message ?? '', /若出现系统安全警告/);
  assert.match(message ?? '', /官方渠道升级 Codex CLI/);
}

test('adds GUI-safe Node locations ahead of Finder PATH without removing it', {
  skip: process.platform !== 'darwin',
}, () => {
  const result = prependGuiNodePaths('/usr/bin:/bin', '/Users/tester');
  const entries = result.split(path.delimiter);
  assert.ok(entries.indexOf('/opt/homebrew/bin') < entries.indexOf('/usr/bin'));
  assert.ok(entries.includes('/usr/local/bin'));
  assert.deepEqual(entries.slice(-2), ['/usr/bin', '/bin']);
});

test('reads allowances through the app-server handshake without starting a model request', async (t) => {
  const { child, requests, respond } = mockCodex(t);
  const pending = readCodexSubscription();
  assert.deepEqual(requests.map(({ method }) => method), ['initialize']);
  child.stdout.write('startup banner\nnull\n');
  child.stdout.write('{"id":1,"res');
  child.stdout.write('ult":{}}\n');
  assert.deepEqual(requests.map(({ method }) => method), ['initialize', 'initialized', 'account/read']);
  respond(2, { account: { type: 'chatgpt', planType: 'plus' } });
  assert.equal(requests.at(-1)?.method, 'account/rateLimits/read');
  respond(3, {
    rateLimits: {
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
    },
  });
  assert.deepEqual(await pending, {
    status: 'ready',
    planLabel: 'Plus',
    fiveHour: { usedPercent: 25, resetsAt: 1_800_000_000 },
    weekly: { usedPercent: 60, resetsAt: 1_800_100_000 },
    message: null,
  });
  assert.equal(child.kill.mock.callCount(), 1);
  child.stdout.write('{"id":1,"result":{}}\n');
  child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  child.emit('exit', 0, null);
  assert.equal(requests.length, 4);
  assert.equal(child.kill.mock.callCount(), 1);
});

test('distinguishes a missing Codex CLI from a CLI that cannot start', async (t) => {
  const { child } = mockCodex(t);
  const pending = readCodexSubscription();
  child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
  const snapshot = await pending;
  assert.equal(snapshot.status, 'not-installed');
  assert.match(snapshot.message ?? '', /安装后重试/);
  assert.equal(child.kill.mock.callCount(), 1);
});

test('gives conditional recovery advice when the CLI cannot start', async (t) => {
  const { child } = mockCodex(t);
  const pending = readCodexSubscription();
  child.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  const snapshot = await pending;
  assert.equal(snapshot.status, 'unavailable');
  assert.match(snapshot.message ?? '', /无法启动/);
  assertCliRecoveryHint(snapshot.message);
});

test('reports premature CLI exit without assuming a revoked certificate', async (t) => {
  const { child } = mockCodex(t);
  const pending = readCodexSubscription();
  child.emit('exit', null, 'SIGKILL');
  const snapshot = await pending;
  assert.equal(snapshot.status, 'unavailable');
  assert.match(snapshot.message ?? '', /意外退出/);
  assertCliRecoveryHint(snapshot.message);
  assert.doesNotMatch(snapshot.message ?? '', /证书.*吊销|恶意软件/);
});

test('handles an asynchronous stdin EPIPE without crashing', async (t) => {
  const { child } = mockCodex(t);
  const pending = readCodexSubscription();
  child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  const snapshot = await pending;
  assert.equal(snapshot.status, 'unavailable');
  assert.match(snapshot.message ?? '', /连接已中断/);
  assertCliRecoveryHint(snapshot.message);
  assert.equal(child.kill.mock.callCount(), 1);
});

test('handles a synchronous stdin write failure without rejecting the request', async (t) => {
  const { child } = mockCodex(t);
  t.mock.method(child.stdin, 'write', () => { throw new Error('stream closed'); });
  const snapshot = await readCodexSubscription();
  assert.equal(snapshot.status, 'unavailable');
  assert.match(snapshot.message ?? '', /连接已中断/);
  assertCliRecoveryHint(snapshot.message);
});

test('times out a silent CLI with actionable advice and stops its process', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child } = mockCodex(t);
  const pending = readCodexSubscription();
  t.mock.timers.tick(10_000);
  const snapshot = await pending;
  assert.equal(snapshot.status, 'unavailable');
  assert.match(snapshot.message ?? '', /超时/);
  assertCliRecoveryHint(snapshot.message);
  assert.equal(child.kill.mock.callCount(), 1);
});

test('suggests upgrading when CLI initialization is rejected', async (t) => {
  const { child } = mockCodex(t);
  const pending = readCodexSubscription();
  child.stdout.write('{"id":1,"error":{"code":-32601,"message":"unsupported"}}\n');
  const snapshot = await pending;
  assert.equal(snapshot.status, 'unavailable');
  assert.match(snapshot.message ?? '', /初始化失败.*升级 Codex CLI/);
});

test('keeps the known plan when reading allowances fails and exposes no RPC error detail', async (t) => {
  const { child, respond } = mockCodex(t);
  const pending = readCodexSubscription();
  respond(1, {});
  respond(2, { account: { type: 'chatgpt', planType: 'plus' } });
  child.stdout.write('{"id":3,"error":{"message":"private authentication detail"}}\n');
  const snapshot = await pending;
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.planLabel, 'Plus');
  assert.match(snapshot.message ?? '', /确认登录状态和网络后重试/);
  assert.doesNotMatch(snapshot.message ?? '', /private authentication detail/);
});

test('keeps signed-out and unsupported accounts distinct from CLI failures', async (t) => {
  for (const [account, status] of [
    [null, 'not-signed-in'],
    [{ type: 'apiKey' }, 'unsupported-account'],
  ] as const) {
    await t.test(status, async (subtest) => {
      const { requests, respond } = mockCodex(subtest);
      const pending = readCodexSubscription();
      respond(1, {});
      respond(2, { account });
      const snapshot = await pending;
      assert.equal(snapshot.status, status);
      assert.equal(snapshot.fiveHour, null);
      assert.equal(snapshot.weekly, null);
      assert.equal(requests.length, 3);
    });
  }
});
