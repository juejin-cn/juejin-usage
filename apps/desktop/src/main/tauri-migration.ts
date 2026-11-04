import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Remote switch + installer list for Electron → Tauri handoff. */
export const MIGRATION_FEED_URL =
  'https://gitee.com/juejin-cn/juejin-usage/raw/main/releases/electron-to-tauri.json';

export type MigrationTarget = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';

export type MigrationFile = {
  url: string;
  sha512: string;
  size?: number;
  target: MigrationTarget;
};

export type MigrationFeed = {
  enabled: boolean;
  version: string;
  message?: string;
  files: MigrationFile[];
};

export type ResolvedMigration = {
  version: string;
  message: string;
  file: MigrationFile;
};

const DEFAULT_MESSAGE = '升级到新版客户端';

export function migrationTargetFor(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): MigrationTarget | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'darwin-x64';
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return 'win32-x64';
  return null;
}

export function parseMigrationFeed(raw: unknown): MigrationFeed | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') return null;
  if (typeof body.version !== 'string' || !body.version.trim()) return null;
  if (!Array.isArray(body.files)) return null;
  const files: MigrationFile[] = [];
  for (const entry of body.files) {
    if (!entry || typeof entry !== 'object') return null;
    const file = entry as Record<string, unknown>;
    if (typeof file.url !== 'string' || !/^https:\/\//i.test(file.url)) return null;
    if (typeof file.sha512 !== 'string' || !file.sha512.trim()) return null;
    if (
      file.target !== 'darwin-arm64' &&
      file.target !== 'darwin-x64' &&
      file.target !== 'win32-x64'
    ) {
      return null;
    }
    files.push({
      url: file.url,
      sha512: file.sha512.trim(),
      target: file.target,
      ...(typeof file.size === 'number' && Number.isFinite(file.size)
        ? { size: file.size }
        : {}),
    });
  }
  return {
    enabled: body.enabled,
    version: body.version.trim(),
    message:
      typeof body.message === 'string' && body.message.trim()
        ? body.message.trim()
        : DEFAULT_MESSAGE,
    files,
  };
}

export function resolveMigration(
  feed: MigrationFeed,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ResolvedMigration | null {
  if (!feed.enabled) return null;
  const target = migrationTargetFor(platform, arch);
  if (!target) return null;
  const file = feed.files.find((entry) => entry.target === target);
  if (!file) return null;
  return { version: feed.version, message: feed.message ?? DEFAULT_MESSAGE, file };
}

export function verifySha512(bytes: Uint8Array, expected: string): boolean {
  const digest = createHash('sha512').update(bytes).digest();
  const normalized = expected.trim();
  return (
    digest.toString('base64') === normalized ||
    digest.toString('hex') === normalized.toLowerCase()
  );
}

export function installerFileName(url: string): string {
  try {
    const name = basename(new URL(url).pathname);
    return name && name !== '/' ? decodeURIComponent(name) : 'tauri-installer';
  } catch {
    return 'tauri-installer';
  }
}

export async function fetchMigrationFeed(
  url: string = MIGRATION_FEED_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<MigrationFeed | null> {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`迁移配置请求失败（HTTP ${response.status}）`);
  }
  return parseMigrationFeed(await response.json());
}

export async function downloadMigrationInstaller(options: {
  file: MigrationFile;
  destinationDir: string;
  onProgress?: (progress: {
    percent: number;
    transferred: number;
    total?: number;
  }) => void;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.file.url);
  if (!response.ok) {
    throw new Error(`下载新版客户端失败（HTTP ${response.status}）`);
  }
  const totalHeader = Number(response.headers.get('content-length') || '');
  const total =
    Number.isFinite(totalHeader) && totalHeader > 0
      ? totalHeader
      : options.file.size;
  const chunks: Uint8Array[] = [];
  let transferred = 0;
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    chunks.push(buffer);
    transferred = buffer.byteLength;
    options.onProgress?.({
      percent: 100,
      transferred,
      ...(total ? { total } : {}),
    });
  } else {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      transferred += value.byteLength;
      const percent =
        total && total > 0
          ? Math.max(0, Math.min(100, (transferred / total) * 100))
          : 0;
      options.onProgress?.({
        percent,
        transferred,
        ...(total ? { total } : {}),
      });
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (!verifySha512(bytes, options.file.sha512)) {
    throw new Error('新版客户端校验失败，请稍后重试');
  }
  await mkdir(options.destinationDir, { recursive: true });
  const path = join(options.destinationDir, installerFileName(options.file.url));
  await writeFile(path, bytes);
  return path;
}
