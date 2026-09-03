import { platform } from 'node:os';

import {
  DEFAULT_DATA_DIR,
  DEFAULT_PORT,
  getRunningOwner,
  loadConfig,
  runtimeKindLabel,
  saveConfig,
  touchStatsSince,
} from '@juejin-opensource/jusage-core';

import {
  clearPid,
  daemonLogPath,
  readDaemonLogTail,
  stopPid,
  waitForServiceReady,
} from './daemon.js';
import { DEFAULT_HOST, formatListenUrl } from './args.js';
import {
  isLinuxAutostartRegistered,
  registerLinuxAutostart,
  unregisterLinuxAutostart,
} from './service-linux.js';
import {
  isMacosAutostartRegistered,
  registerMacosAutostart,
  unregisterMacosAutostart,
} from './service-macos.js';
import {
  isWindowsAutostartRegistered,
  registerWindowsAutostart,
  unregisterWindowsAutostart,
} from './service-windows.js';

type ServicePlatform = 'darwin' | 'win32' | 'linux';

function assertSupportedPlatform(): ServicePlatform {
  const p = platform();
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  throw new Error(`jusage service 仅支持 macOS、Windows 与 Linux（当前: ${p}）`);
}

async function isAutostartRegistered(): Promise<boolean> {
  const p = assertSupportedPlatform();
  if (p === 'darwin') return isMacosAutostartRegistered();
  if (p === 'win32') return isWindowsAutostartRegistered();
  return isLinuxAutostartRegistered();
}

async function registerAutostart(cliBinPath: string, dataDir: string): Promise<void> {
  const p = assertSupportedPlatform();
  if (p === 'darwin') {
    await registerMacosAutostart(cliBinPath, dataDir);
    return;
  }
  if (p === 'win32') {
    await registerWindowsAutostart(cliBinPath, dataDir);
    return;
  }
  await registerLinuxAutostart(cliBinPath, dataDir);
}

async function unregisterAutostart(): Promise<void> {
  const p = assertSupportedPlatform();
  if (p === 'darwin') {
    await unregisterMacosAutostart();
    return;
  }
  if (p === 'win32') {
    await unregisterWindowsAutostart();
    return;
  }
  await unregisterLinuxAutostart();
}

export async function cmdServiceStart(
  cliBinPath: string,
  daysAgo?: number,
  listen?: { port?: number; host?: string },
): Promise<void> {
  assertSupportedPlatform();
  const startedAt = Date.now();
  const waitTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  仍在等待检测中（已 ${elapsed}s）…`);
  }, 3_000);

  try {
    await cmdServiceStartBody(cliBinPath, daysAgo, listen);
  } finally {
    clearInterval(waitTimer);
  }
}

async function cmdServiceStartBody(
  cliBinPath: string,
  daysAgo?: number,
  listen?: { port?: number; host?: string },
): Promise<void> {
  const { dir, config } = await loadConfig();
  // Seed statsSince before launchd starts `jusage start` (do not bake --days into plist).
  await touchStatsSince(dir, config, daysAgo != null ? { daysAgo } : undefined);
  if (listen?.port != null) config.serverPort = listen.port;
  if (listen?.host != null) config.serverHost = listen.host;
  if (listen?.port != null || listen?.host != null) {
    await saveConfig(dir, config);
  }
  const existing = await getRunningOwner(dir);

  if (existing != null) {
    // Already running: still ensure autostart is registered.
    const who = runtimeKindLabel(existing.kind);
    const registered = await isAutostartRegistered();
    if (!registered) {
      await registerAutostart(cliBinPath, dir);
      console.log(
        `服务已在运行（${who} pid ${existing.pid}），已补注册开机自启`,
      );
    } else {
      console.log(`服务已在运行（${who} pid ${existing.pid}）`);
    }
    if (existing.kind === 'desktop') {
      console.log('  提示: 当前 runtime owner 是桌面端，同步/上报由桌面负责');
      console.log('  如需浏览器面板，可另开终端执行 jusage start（观察模式，只读）');
    }
    console.log(`  面板: ${formatListenUrl(config.serverHost || DEFAULT_HOST, config.serverPort || DEFAULT_PORT)}`);
    return;
  }

  await registerAutostart(cliBinPath, dir);
  const port = config.serverPort || DEFAULT_PORT;
  const host = config.serverHost || DEFAULT_HOST;
  const ready = await waitForServiceReady(dir, port, host);
  if (ready.pid == null && !ready.health) {
    const logPath = daemonLogPath(dir);
    const tail = await readDaemonLogTail(dir);
    const hint = tail ? `\n--- daemon.log ---\n${tail}` : '';
    throw new Error(
      `自启已注册，但进程未在预期时间内启动（/health 也未就绪），请查看 ${logPath}${hint}`,
    );
  }

  const { config: refreshed } = await loadConfig(dir);
  const panelPort = refreshed.serverPort || DEFAULT_PORT;
  const panelHost = refreshed.serverHost || DEFAULT_HOST;
  if (ready.pid != null) {
    console.log(`✓ 服务已在后台启动 (pid ${ready.pid})`);
  } else {
    console.log('✓ 服务已在后台启动（面板 /health 已就绪）');
  }
  console.log(`  面板: ${formatListenUrl(panelHost, panelPort)}`);
  console.log(`  数据: ${dir}`);
  console.log(`  开机自启: 已注册`);
  console.log(`  日志: ${dir}/logs/daemon.log`);
}

export async function cmdServiceStop(): Promise<void> {
  assertSupportedPlatform();
  const { dir } = await loadConfig();

  // Unregister first so KeepAlive / task restart cannot bring the process back.
  await unregisterAutostart();

  const owner = await getRunningOwner(dir);
  if (owner != null) {
    if (owner.kind === 'desktop') {
      // Do not kill the Electron process; only clear CLI autostart above.
      console.log(
        `✓ 开机自启已取消（当前 runtime owner 是桌面端 pid ${owner.pid}，未结束桌面进程）`,
      );
      return;
    }
    const stopped = await stopPid(owner.pid);
    if (!stopped) {
      throw new Error(`无法停止进程 pid ${owner.pid}`);
    }
  }
  await clearPid(dir);
  console.log('✓ 服务已停止，开机自启已取消');
}

export async function cmdServiceStatus(): Promise<void> {
  assertSupportedPlatform();
  const { dir, config } = await loadConfig();
  const owner = await getRunningOwner(dir);
  const registered = await isAutostartRegistered();
  const port = config.serverPort || DEFAULT_PORT;
  const host = config.serverHost || DEFAULT_HOST;

  if (owner != null) {
    console.log(
      `服务: 运行中（${runtimeKindLabel(owner.kind)} pid ${owner.pid}）`,
    );
  } else {
    console.log('服务: 未运行');
  }
  console.log(`开机自启: ${registered ? '已注册' : '未注册'}`);
  console.log(`面板: ${formatListenUrl(host, port)}`);
  console.log(`数据: ${dir || DEFAULT_DATA_DIR}`);
  console.log(`云端同步: ${config.juejin.enabled ? '已开启' : '未开启'} → ${config.juejin.apiUrl}`);
  console.log(`上次同步: ${config.lastSyncAt ?? '从未'}`);
  console.log(`上次上报: ${config.lastUploadAt ?? '从未'}`);
  console.log(`日志: ${dir}/logs/daemon.log`);
}
