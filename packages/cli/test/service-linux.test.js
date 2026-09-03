import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';

import {
  buildLinuxUnit,
  isLinuxAutostartRegistered,
  registerLinuxAutostart,
  systemdQuote,
} from '../dist/service-linux.js';

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

async function linuxServiceFixture(t, failAction) {
  const root = await mkdtemp(join(tmpdir(), 'jusage-linux-service-'));
  const fakeBin = join(root, 'bin');
  const configHome = join(root, 'config');
  const unitPath = join(configHome, 'systemd', 'user', 'jusage.service');
  const previousEnv = {
    path: process.env.PATH,
    configHome: process.env.XDG_CONFIG_HOME,
    failAction: process.env.JUSAGE_TEST_FAIL_ACTION,
    unitPath: process.env.JUSAGE_TEST_UNIT_PATH,
  };
  t.after(async () => {
    restoreEnv('PATH', previousEnv.path);
    restoreEnv('XDG_CONFIG_HOME', previousEnv.configHome);
    restoreEnv('JUSAGE_TEST_FAIL_ACTION', previousEnv.failAction);
    restoreEnv('JUSAGE_TEST_UNIT_PATH', previousEnv.unitPath);
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, 'systemctl'),
    `#!/bin/sh
action="$2"
if [ "$JUSAGE_TEST_FAIL_ACTION" = "is-enabled" ] && [ "$action" = "is-enabled" ]; then
  exit 1
fi
if [ "$JUSAGE_TEST_FAIL_ACTION" = "enable" ] && [ "$action" = "enable" ]; then
  echo "simulated enable failure" >&2
  exit 1
fi
if [ "$JUSAGE_TEST_FAIL_ACTION" = "daemon-reload" ] && [ "$action" = "daemon-reload" ] && [ -f "$JUSAGE_TEST_UNIT_PATH" ]; then
  echo "simulated reload failure" >&2
  exit 1
fi
exit 0
`,
    { encoding: 'utf8', mode: 0o755 },
  );

  process.env.PATH = `${fakeBin}${delimiter}${previousEnv.path ?? ''}`;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.JUSAGE_TEST_FAIL_ACTION = failAction;
  process.env.JUSAGE_TEST_UNIT_PATH = unitPath;
  return { dataDir: join(root, 'data'), unitPath };
}

test('buildLinuxUnit writes ExecStart, Restart, and log paths', () => {
  const unit = buildLinuxUnit(
    '/usr/bin/node',
    ['/usr/lib/node_modules/@juejin-opensource/jusage/bin/jusage.js', 'start'],
    '/home/dev',
    '/home/dev/.ai-usage/logs/daemon.log',
  );

  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node \/usr\/lib\/node_modules\/@juejin-opensource\/jusage\/bin\/jusage\.js start/,
  );
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=3$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/dev$/m);
  assert.match(unit, /^Environment=HOME=\/home\/dev$/m);
  assert.match(unit, /StandardOutput=append:\/home\/dev\/\.ai-usage\/logs\/daemon\.log/);
  assert.match(unit, /StandardError=append:\/home\/dev\/\.ai-usage\/logs\/daemon\.log/);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(unit, /\/home\/dev\/\.local\/bin/);
});

test('systemdQuote and buildLinuxUnit escape spaces and percent', () => {
  assert.equal(systemdQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(systemdQuote('/home/foo bar/node'), '"/home/foo bar/node"');
  assert.equal(systemdQuote('/tmp/100%ready/node'), '"/tmp/100%%ready/node"');

  const unit = buildLinuxUnit(
    '/home/foo bar/node',
    ['/home/foo bar/jusage.js', 'start'],
    '/home/foo bar',
    '/home/foo bar/.ai-usage/logs/daemon.log',
  );
  assert.match(unit, /ExecStart="\/home\/foo bar\/node" "\/home\/foo bar\/jusage\.js" start/);
  assert.match(unit, /WorkingDirectory="\/home\/foo bar"/);
  assert.match(unit, /StandardOutput=append:"\/home\/foo bar\/\.ai-usage\/logs\/daemon\.log"/);
});

test(
  'isLinuxAutostartRegistered checks whether systemd enabled the unit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await linuxServiceFixture(t, 'is-enabled');
    await mkdir(dirname(fixture.unitPath), { recursive: true });
    await writeFile(fixture.unitPath, '[Unit]\nDescription=Juejin Usage CLI\n', 'utf8');

    assert.equal(await isLinuxAutostartRegistered(), false);
    process.env.JUSAGE_TEST_FAIL_ACTION = '';
    assert.equal(await isLinuxAutostartRegistered(), true);
  },
);

test(
  'registerLinuxAutostart removes the unit when enable fails',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await linuxServiceFixture(t, 'enable');

    await assert.rejects(
      registerLinuxAutostart('/tmp/jusage.js', fixture.dataDir),
      /注册 Linux 自启失败: simulated enable failure/,
    );

    assert.equal(existsSync(fixture.unitPath), false);
    assert.equal(await isLinuxAutostartRegistered(), false);
  },
);

test(
  'registerLinuxAutostart removes the unit when daemon-reload fails',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await linuxServiceFixture(t, 'daemon-reload');

    await assert.rejects(
      registerLinuxAutostart('/tmp/jusage.js', fixture.dataDir),
      /注册 Linux 自启失败（daemon-reload）: simulated reload failure/,
    );

    assert.equal(existsSync(fixture.unitPath), false);
    assert.equal(await isLinuxAutostartRegistered(), false);
  },
);
