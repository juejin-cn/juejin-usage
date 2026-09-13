import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  codexPlanLabel,
  mapCodexRateLimitWindows,
  type CodexSubscriptionSnapshot,
} from '../shared/codex-subscription';

const REQUEST_TIMEOUT_MS = 10_000;

type JsonRpcMessage = { id?: number; result?: unknown; error?: { message?: unknown } };
type AccountResult = { account?: { type?: unknown; planType?: unknown } | null };
type RateLimitResult = { rateLimits?: { primary?: unknown; secondary?: unknown } | null };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function unavailable(status: CodexSubscriptionSnapshot['status'], message: string, planLabel: string | null = null): CodexSubscriptionSnapshot {
  return { status, planLabel, fiveHour: null, weekly: null, message };
}

/** The macOS GUI PATH often omits pnpm's global-bin directory. */
function resolveCodexCommand(): string {
  if (process.platform !== 'darwin') return 'codex';
  const pnpmCommand = path.join(process.env.HOME ?? '', 'Library/pnpm/codex');
  return existsSync(pnpmCommand) ? pnpmCommand : 'codex';
}

/** Fetch via Codex app-server without reading or exposing auth.json. */
export function readCodexSubscription(): Promise<CodexSubscriptionSnapshot> {
  return new Promise((resolve) => {
    const child = spawn(resolveCodexCommand(), ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let settled = false;
    let stdout = '';
    let planLabel: string | null = null;
    const finish = (snapshot: CodexSubscriptionSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(snapshot);
    };
    const fail = (message: string) => finish(unavailable('unavailable', message, planLabel));
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timeout = setTimeout(() => fail('读取限额超时，请稍后重试'), REQUEST_TIMEOUT_MS);

    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        finish(unavailable('not-installed', '未检测到本机 Codex CLI'));
      } else {
        fail('无法启动本机 Codex CLI');
      }
    });
    child.once('exit', () => { if (!settled) fail('Codex CLI 意外退出'); });
    // The protocol is stdout-only; drain diagnostics so a noisy CLI cannot
    // block while the tray is waiting for its small account response.
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        let message: JsonRpcMessage;
        try { message = JSON.parse(line) as JsonRpcMessage; } catch { continue; }
        if (message.id === 1) {
          if (message.error) { fail('本机 Codex CLI 不支持订阅读取'); continue; }
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'account/read', params: {} });
          continue;
        }
        if (message.id === 2) {
          if (message.error) { finish(unavailable('not-signed-in', '请先使用 ChatGPT 账号登录 Codex')); continue; }
          const account = (message.result as AccountResult | undefined)?.account;
          if (!account) { finish(unavailable('not-signed-in', '请先使用 ChatGPT 账号登录 Codex')); continue; }
          if (account.type !== 'chatgpt') { finish(unavailable('unsupported-account', '当前 Codex 未使用 ChatGPT 订阅')); continue; }
          planLabel = codexPlanLabel(account.planType);
          send({ jsonrpc: '2.0', id: 3, method: 'account/rateLimits/read', params: {} });
          continue;
        }
        if (message.id === 3) {
          if (message.error) { finish(unavailable('unavailable', '暂时无法读取 Codex 限额', planLabel)); continue; }
          const rateLimits = (message.result as RateLimitResult | undefined)?.rateLimits;
          const windows = mapCodexRateLimitWindows({
            primary: asRecord(rateLimits?.primary),
            secondary: asRecord(rateLimits?.secondary),
          });
          finish({
            status: windows.fiveHour || windows.weekly ? 'ready' : 'unavailable',
            planLabel, ...windows,
            message: windows.fiveHour || windows.weekly ? null : '暂时无法读取 Codex 限额',
          });
        }
      }
    });
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'jusage-desktop', version: '0.1.0' }, capabilities: { optOutNotificationMethods: ['thread/started'] } },
    });
  });
}
