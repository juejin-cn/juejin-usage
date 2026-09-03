import { DEFAULT_PORT } from '@juejin-opensource/jusage-core';

export const DEFAULT_HOST = '127.0.0.1';

export function isWildcardListenHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

export function formatListenUrl(host: string, port: number): string {
  const display = isWildcardListenHost(host) ? DEFAULT_HOST : host;
  const formatted =
    display.includes(':') && !display.startsWith('[') ? `[${display}]` : display;
  return `http://${formatted}:${port}`;
}

export interface ParsedArgs {
  command: string;
  serviceAction?: string;
  /** Set only when --port is passed. */
  port?: number;
  /** Set only when --host is passed. */
  host?: string;
  source?: string;
  force?: boolean;
  reconcile?: boolean;
  /** Hidden debug: seed statsSince to N days ago when missing. Not shown in --help. */
  days?: number;
}

export function normalizeListenHost(raw: string): string {
  const host = raw.trim();
  if (!host) {
    throw new Error('--host 不能为空，例如 0.0.0.0 或 127.0.0.1');
  }
  if (/[\s/?#]/.test(host)) {
    throw new Error(`无效的 --host: ${raw}`);
  }
  return host;
}

function isFlagToken(value: string | undefined): boolean {
  return value != null && value.startsWith('-') && value !== '-';
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command = args[0] ?? 'start';
  let serviceAction: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let source: string | undefined;
  let force = false;
  let reconcile = false;
  let days: number | undefined;

  if (
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    args.includes('--help') ||
    args.includes('-h')
  ) {
    return { command: 'help', port, host, source, force, reconcile };
  }

  if (command === 'service') {
    serviceAction = args[1];
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = Number(args[i + 1]) || DEFAULT_PORT;
      i += 1;
    } else if (args[i] === '--host') {
      if (isFlagToken(args[i + 1]) || args[i + 1] == null) {
        throw new Error('--host 需要地址，例如 0.0.0.0 或 127.0.0.1');
      }
      host = normalizeListenHost(args[i + 1]);
      i += 1;
    } else if (args[i]?.startsWith('--host=')) {
      host = normalizeListenHost(args[i].slice('--host='.length));
    } else if (args[i] === '--source' && args[i + 1]) {
      source = args[i + 1];
      i += 1;
    } else if (args[i]?.startsWith('--source=')) {
      source = args[i].slice('--source='.length);
    } else if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--reconcile') {
      reconcile = true;
    } else if (args[i] === '--days' && args[i + 1]) {
      days = Number(args[i + 1]);
      i += 1;
    } else if (args[i]?.startsWith('--days=')) {
      days = Number(args[i].slice('--days='.length));
    }
  }
  if (command.startsWith('-')) command = 'start';
  return { command, serviceAction, port, host, source, force, reconcile, days };
}

export function resolveDaysAgo(days: number | undefined): number | undefined {
  if (days === undefined) return undefined;
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error(`--days 须为正整数，收到: ${days}`);
  }
  return days;
}

export function printHelp(): void {
  console.log(`Usage: jusage <command> [options]

Commands:
  start                 前台启动本地面板与同步（默认；桌面已运行时为观察模式）
  stop                  停止当前进程内的服务
  status                查看 CLI / 面板当前启动状态
  sync                  手动同步本地用量数据
  upload                上报数据到云端
  service <action>      后台服务与开机自启（macOS / Windows / Linux）
                        action: start | stop | status
  help                  显示帮助

Options:
  --port <number>       面板端口（默认 ${DEFAULT_PORT}）
  --host <address>      面板监听地址（默认 ${DEFAULT_HOST}；局域网访问用 0.0.0.0）
  --source <name>       sync 数据源：claude | codex | cursor | qoder | trae | gemini | opencode | copilot | antigravity | openclaw | hermes | zcode | pi | kimi | roocode | droid | kiro | cline | amp | qwen | codebuddy | workbuddy | grok | mimo | every-code | omp | kilo-cli | kilocode | goose | zed | warp | all
  --force               upload 时忽略云端同步开关，强制上报
  --reconcile           upload 时做全量对账
  -h, --help            显示帮助

Examples:
  jusage
  jusage start --port 8452
  jusage start --host 0.0.0.0
  jusage status
  jusage sync --source=claude
  jusage upload --force
  jusage service start`);
}
