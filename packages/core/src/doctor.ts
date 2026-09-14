import { access, constants, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';

import { loadConfig } from './config.js';
import { DEFAULT_DATA_DIR, DEFAULT_PORT } from './paths.js';
import { isPidAlive, pidFilePath, readRuntimeOwner, runtimeKindLabel } from './runtime-pid.js';
import { getHookStatus } from './server/state.js';
import { isSyncSourcePresent } from './sync/source-presence.js';
import { TOOL_CATALOG } from './tool-catalog.js';
import type { TudConfig } from './types.js';

export type DoctorStatus = 'ok' | 'warn' | 'error' | 'info';

export interface DoctorCheckItem {
  id: string;
  name: string;
  status: DoctorStatus;
  message: string;
  detail?: string;
  suggestion?: string;
}

export interface DoctorCollectorItem {
  key: string;
  displayName: string;
  present: boolean;
  hookStatus?: 'active' | 'inactive';
  detail?: string;
}

export interface DoctorCategory {
  id: string;
  title: string;
  status: DoctorStatus;
  items: DoctorCheckItem[];
}

export interface DoctorReport {
  timestamp: string;
  categories: DoctorCategory[];
  collectors: {
    total: number;
    detected: number;
    items: DoctorCollectorItem[];
  };
  summary: {
    status: DoctorStatus;
    okCount: number;
    warnCount: number;
    errorCount: number;
    suggestions: string[];
  };
}

export interface RunDoctorOptions {
  dataDir?: string;
  config?: TudConfig;
  port?: number;
  skipNetworkProbe?: boolean;
}

/** Check TCP port accessibility */
function checkPortOpen(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

/** Probe network endpoint reachability and latency */
async function probeUrl(url: string, timeoutMs = 3000): Promise<{ reachable: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(async () => {
      // Fallback to GET if HEAD method is not allowed by some endpoints
      return await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
    });
    const latencyMs = Date.now() - start;
    // Any HTTP response (including 401, 403, 404) means network and DNS are reachable
    return { reachable: res.status < 500 || res.status === 502 || res.status === 503, latencyMs };
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveCategoryStatus(items: DoctorCheckItem[]): DoctorStatus {
  if (items.some((i) => i.status === 'error')) return 'error';
  if (items.some((i) => i.status === 'warn')) return 'warn';
  return 'ok';
}

export async function runDoctorDiagnostics(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  let config: TudConfig;
  let configError: string | null = null;

  try {
    if (options.config) {
      config = options.config;
    } else {
      const loaded = await loadConfig(dataDir);
      config = loaded.config;
    }
  } catch (err) {
    configError = err instanceof Error ? err.message : String(err);
    config = {
      deviceId: 'unknown',
      hostname: 'localhost',
      dataDir,
      statsSince: new Date().toISOString(),
      juejin: {
        enabled: false,
        apiUrl: 'https://juejin.cn',
        authMode: 'manual',
        token: null,
      },
    };
  }

  const port = options.port ?? DEFAULT_PORT;
  const categories: DoctorCategory[] = [];
  const suggestions: string[] = [];

  // ==========================================
  // 1. Runtime & Process
  // ==========================================
  const runtimeItems: DoctorCheckItem[] = [];

  // Node.js version
  const nodeVer = process.versions.node;
  const majorNodeVer = parseInt(nodeVer.split('.')[0] ?? '0', 10);
  if (majorNodeVer >= 20) {
    runtimeItems.push({
      id: 'runtime-node',
      name: 'Node.js 版本',
      status: 'ok',
      message: `v${nodeVer} (符合 >= 20 要求)`,
    });
  } else {
    const item: DoctorCheckItem = {
      id: 'runtime-node',
      name: 'Node.js 版本',
      status: 'error',
      message: `当前版本 v${nodeVer} 低于要求 (需要 Node.js >= 20)`,
      suggestion: '请升级 Node.js 到 20 或更高版本以保证功能正常运行。',
    };
    runtimeItems.push(item);
    suggestions.push(item.suggestion!);
  }

  // OS & Platform
  runtimeItems.push({
    id: 'runtime-os',
    name: '操作系统',
    status: 'ok',
    message: `${process.platform} (${process.arch})`,
  });

  // PID Lock & Running owner
  const owner = await readRuntimeOwner(dataDir);
  const pidFile = pidFilePath(dataDir);
  const pidExists = existsSync(pidFile);

  if (owner) {
    const alive = isPidAlive(owner.pid);
    if (alive) {
      runtimeItems.push({
        id: 'runtime-pid',
        name: '服务进程锁',
        status: 'ok',
        message: `${runtimeKindLabel(owner.kind)} 正在运行 (PID: ${owner.pid}, 角色: owner)`,
      });
    } else {
      const item: DoctorCheckItem = {
        id: 'runtime-pid',
        name: '服务进程锁',
        status: 'warn',
        message: `检测到失效的锁文件 (PID: ${owner.pid} 已无响应)`,
        detail: `锁文件路径: ${pidFile}`,
        suggestion: `若遇到服务无法启动或无法抢占，请尝试删除陈旧的锁文件: rm "${pidFile}"`,
      };
      runtimeItems.push(item);
      suggestions.push(item.suggestion!);
    }
  } else if (pidExists) {
    const item: DoctorCheckItem = {
      id: 'runtime-pid',
      name: '服务进程锁',
      status: 'warn',
      message: '存在未识别格式的 tud.pid 文件',
      suggestion: `建议清理异常的锁文件: rm "${pidFile}"`,
    };
    runtimeItems.push(item);
    suggestions.push(item.suggestion!);
  } else {
    runtimeItems.push({
      id: 'runtime-pid',
      name: '服务进程锁',
      status: 'info',
      message: '当前无常驻主服务在运行 (空闲状态)',
    });
  }

  // Local port probe
  const portOpen = await checkPortOpen(port);
  if (portOpen) {
    runtimeItems.push({
      id: 'runtime-port',
      name: '面板端口',
      status: 'ok',
      message: `端口 ${port} 正在监听服务 (http://127.0.0.1:${port})`,
    });
  } else {
    runtimeItems.push({
      id: 'runtime-port',
      name: '面板端口',
      status: 'info',
      message: `端口 ${port} 未处于监听状态 (可通过 jusage start 启动)`,
    });
  }

  categories.push({
    id: 'runtime',
    title: '运行环境与进程状态',
    status: resolveCategoryStatus(runtimeItems),
    items: runtimeItems,
  });

  // ==========================================
  // 2. Storage & Permissions
  // ==========================================
  const storageItems: DoctorCheckItem[] = [];

  // Data dir permissions
  try {
    await access(dataDir, constants.R_OK | constants.W_OK);
    storageItems.push({
      id: 'storage-datadir',
      name: '数据目录',
      status: 'ok',
      message: `${dataDir} (读写正常)`,
    });
  } catch (err) {
    const item: DoctorCheckItem = {
      id: 'storage-datadir',
      name: '数据目录',
      status: 'error',
      message: `${dataDir} 访问受限`,
      detail: err instanceof Error ? err.message : String(err),
      suggestion: `请检查数据目录读写权限: chmod -R u+rw "${dataDir}"`,
    };
    storageItems.push(item);
    suggestions.push(item.suggestion!);
  }

  // Config file
  if (configError) {
    const item: DoctorCheckItem = {
      id: 'storage-config',
      name: '配置文件',
      status: 'error',
      message: 'tud.config.json 解析失败',
      detail: configError,
      suggestion: '配置文件可能损坏，可尝试修复 JSON 格式或备份后重新初始化。',
    };
    storageItems.push(item);
    suggestions.push(item.suggestion!);
  } else {
    storageItems.push({
      id: 'storage-config',
      name: '配置文件',
      status: 'ok',
      message: `有效 (设备 UUID: ${config.deviceId})`,
    });
  }

  // Logs directory
  const logsDir = join(dataDir, 'logs');
  try {
    if (existsSync(logsDir)) {
      await access(logsDir, constants.R_OK | constants.W_OK);
      storageItems.push({
        id: 'storage-logs',
        name: '日志目录',
        status: 'ok',
        message: `${logsDir} (可正常写入)`,
      });
    } else {
      storageItems.push({
        id: 'storage-logs',
        name: '日志目录',
        status: 'info',
        message: `${logsDir} 尚未创建 (将在首次启动时初始化)`,
      });
    }
  } catch (err) {
    const item: DoctorCheckItem = {
      id: 'storage-logs',
      name: '日志目录',
      status: 'warn',
      message: `${logsDir} 权限异常`,
      detail: err instanceof Error ? err.message : String(err),
      suggestion: `请确保日志目录有可写权限: chmod -R u+w "${logsDir}"`,
    };
    storageItems.push(item);
    suggestions.push(item.suggestion!);
  }

  // Queue cursors file
  const cursorsPath = join(dataDir, 'queue', 'cursors.json');
  if (existsSync(cursorsPath)) {
    try {
      const content = await readFile(cursorsPath, 'utf-8');
      const cursors = JSON.parse(content);
      const trackedSources = Object.keys(cursors).length;
      storageItems.push({
        id: 'storage-cursors',
        name: '同步游标',
        status: 'ok',
        message: `游标记录完好 (已记录 ${trackedSources} 个数据源的同步状态)`,
      });
    } catch {
      const item: DoctorCheckItem = {
        id: 'storage-cursors',
        name: '同步游标',
        status: 'warn',
        message: 'queue/cursors.json 解析失败',
        suggestion: '游标文件格式异常，可运行 jusage sync 进行自动修复。',
      };
      storageItems.push(item);
      suggestions.push(item.suggestion!);
    }
  } else {
    storageItems.push({
      id: 'storage-cursors',
      name: '同步游标',
      status: 'info',
      message: '尚未产生同步游标记录 (将在首次数据同步后生成)',
    });
  }

  categories.push({
    id: 'storage',
    title: '数据存储与权限',
    status: resolveCategoryStatus(storageItems),
    items: storageItems,
  });

  // ==========================================
  // 3. AI Collectors & Tools
  // ==========================================
  let hookStatus: { claude: boolean; codex: boolean } = { claude: false, codex: false };
  try {
    hookStatus = await getHookStatus(dataDir);
  } catch {
    // ignore hook check failure
  }

  const collectorItems: DoctorCollectorItem[] = [];
  for (const tool of TOOL_CATALOG) {
    const present = isSyncSourcePresent(tool.key);
    let hook: 'active' | 'inactive' | undefined;
    if (tool.key === 'claude') {
      hook = hookStatus.claude ? 'active' : 'inactive';
    } else if (tool.key === 'codex') {
      hook = hookStatus.codex ? 'active' : 'inactive';
    }
    collectorItems.push({
      key: tool.key,
      displayName: tool.displayName,
      present,
      hookStatus: hook,
    });
  }

  const detectedCollectors = collectorItems.filter((c) => c.present);
  const toolCheckItems: DoctorCheckItem[] = [];

  if (detectedCollectors.length > 0) {
    toolCheckItems.push({
      id: 'collectors-summary',
      name: '已探测工具',
      status: 'ok',
      message: `检测到 ${detectedCollectors.length} 款 AI 编程工具存在本地有效数据源`,
      detail: detectedCollectors
        .map((c) => `${c.displayName}${c.hookStatus ? ` (Hook: ${c.hookStatus})` : ''}`)
        .join(', '),
    });
  } else {
    const item: DoctorCheckItem = {
      id: 'collectors-summary',
      name: '已探测工具',
      status: 'warn',
      message: '未在系统中检测到任何支持的 AI 工具日志或数据库',
      suggestion:
        '请确认是否已使用过支持的 AI 工具（如 Cursor、Claude Code、Codex、Trae 等）并产生过对话用量。',
    };
    toolCheckItems.push(item);
    suggestions.push(item.suggestion!);
  }

  categories.push({
    id: 'collectors',
    title: `本地 AI 工具与数据源 (已检测到 ${detectedCollectors.length} / ${collectorItems.length} 款)`,
    status: resolveCategoryStatus(toolCheckItems),
    items: toolCheckItems,
  });

  // ==========================================
  // 4. Cloud Sync & Network
  // ==========================================
  const networkItems: DoctorCheckItem[] = [];

  // Cloud sync status
  if (config.juejin.enabled) {
    networkItems.push({
      id: 'cloud-enabled',
      name: '云端同步开关',
      status: 'ok',
      message: '已开启',
    });
  } else {
    networkItems.push({
      id: 'cloud-enabled',
      name: '云端同步开关',
      status: 'info',
      message: '未开启 (仅保存与展示本地数据)',
    });
  }

  // Token status
  if (config.juejin.token) {
    networkItems.push({
      id: 'cloud-token',
      name: '上报 Token',
      status: 'ok',
      message: '已配置',
    });
  } else if (config.juejin.enabled) {
    const item: DoctorCheckItem = {
      id: 'cloud-token',
      name: '上报 Token',
      status: 'warn',
      message: '云端同步已开启，但尚未配置有效 Token',
      suggestion: '可在桌面端「设置」中登录绑定掘金账号，或在配置文件中填入 token。',
    };
    networkItems.push(item);
    suggestions.push(item.suggestion!);
  } else {
    networkItems.push({
      id: 'cloud-token',
      name: '上报 Token',
      status: 'info',
      message: '未配置',
    });
  }

  // Network probe
  if (!options.skipNetworkProbe && config.juejin.apiUrl) {
    const probe = await probeUrl(config.juejin.apiUrl);
    if (probe.reachable) {
      networkItems.push({
        id: 'cloud-network',
        name: '云端 API 连通性',
        status: 'ok',
        message: `${config.juejin.apiUrl} 正常连通 (响应延迟: ${probe.latencyMs ?? 0}ms)`,
      });
    } else {
      const status: DoctorStatus = config.juejin.enabled ? 'error' : 'warn';
      const item: DoctorCheckItem = {
        id: 'cloud-network',
        name: '云端 API 连通性',
        status,
        message: `无法连接到 ${config.juejin.apiUrl}`,
        detail: probe.error,
        suggestion: '请检查网络连接、DNS 解析或代理设置，确认是否可正常访问掘金云端服务。',
      };
      networkItems.push(item);
      suggestions.push(item.suggestion!);
    }
  }

  categories.push({
    id: 'network',
    title: '云端同步与网络',
    status: resolveCategoryStatus(networkItems),
    items: networkItems,
  });

  // Calculate overall summary
  let okCount = 0;
  let warnCount = 0;
  let errorCount = 0;

  for (const cat of categories) {
    for (const item of cat.items) {
      if (item.status === 'ok') okCount++;
      else if (item.status === 'warn') warnCount++;
      else if (item.status === 'error') errorCount++;
    }
  }

  const overallStatus: DoctorStatus =
    errorCount > 0 ? 'error' : warnCount > 0 ? 'warn' : 'ok';

  return {
    timestamp: new Date().toISOString(),
    categories,
    collectors: {
      total: collectorItems.length,
      detected: detectedCollectors.length,
      items: collectorItems,
    },
    summary: {
      status: overallStatus,
      okCount,
      warnCount,
      errorCount,
      suggestions: Array.from(new Set(suggestions)),
    },
  };
}
