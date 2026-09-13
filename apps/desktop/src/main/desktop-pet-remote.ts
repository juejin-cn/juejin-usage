import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopPetDefinition } from '../shared/desktop-pet-catalog.js';
import {
  BUILTIN_DESKTOP_PET_IDS,
  DESKTOP_PET_ID_PATTERN,
  DESKTOP_PET_MANIFEST_NAME,
  DESKTOP_PET_MAX_MANIFEST_BYTES,
  DESKTOP_PET_MAX_SPRITESHEET_BYTES,
  DESKTOP_PET_SPRITESHEET_NAME,
  inspectDesktopPetPackage,
} from './desktop-pet-scanner.js';

const REQUEST_TIMEOUT_MS = 8_000;
const MANIFEST_CONCURRENCY = 5;
const DEFAULT_GLOW = { primary: '#7c8cff', accent: '#69d4ff' };

const GITEE_CONTENTS_URL =
  'https://gitee.com/api/v5/repos/juejin-cn/juejin-usage/contents/pets';
const GITHUB_CONTENTS_URL =
  'https://api.github.com/repos/juejin-cn/juejin-usage/contents/pets';
const GITEE_RAW_BASE = 'https://gitee.com/juejin-cn/juejin-usage/raw/main';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/juejin-cn/juejin-usage/main';

type RemoteHost = 'gitee' | 'github';

interface ContentsEntry {
  name?: unknown;
  type?: unknown;
}

interface RemotePetManifest {
  id?: unknown;
  displayName?: unknown;
  description?: unknown;
  glow?: { primary?: unknown; accent?: unknown };
}

interface CachedRemoteCatalog {
  host: RemoteHost;
  pets: DesktopPetDefinition[];
  fetchedAt: number;
}

let cachedRemote: CachedRemoteCatalog | null = null;
const installLocks = new Map<string, Promise<void>>();

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function isDirectoryEntry(entry: ContentsEntry): entry is ContentsEntry & { name: string } {
  if (typeof entry.name !== 'string' || !entry.name) return false;
  return entry.type === 'dir' || entry.type === 'directory';
}

async function fetchText(
  url: string,
  options: { maxBytes: number; accept?: string } = { maxBytes: DESKTOP_PET_MAX_MANIFEST_BYTES },
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: options.accept ?? 'application/json',
      'User-Agent': 'jusage-desktop-pet',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > options.maxBytes) {
    throw new Error('响应过大');
  }
  return buffer.toString('utf8');
}

async function fetchBinary(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'jusage-desktop-pet' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error('文件过大');
  return buffer;
}

function rawBase(host: RemoteHost): string {
  return host === 'gitee' ? GITEE_RAW_BASE : GITHUB_RAW_BASE;
}

function petRawUrl(host: RemoteHost, id: string, fileName: string): string {
  return `${rawBase(host)}/pets/${encodeURIComponent(id)}/${fileName}`;
}

async function listPetDirectories(host: RemoteHost): Promise<string[]> {
  const url = host === 'gitee' ? GITEE_CONTENTS_URL : GITHUB_CONTENTS_URL;
  const text = await fetchText(url, {
    maxBytes: 512 * 1024,
    accept: 'application/json',
  });
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error('目录列表不是有效 JSON');
  }
  if (!Array.isArray(payload)) throw new Error('目录列表格式无效');
  const ids: string[] = [];
  for (const entry of payload as ContentsEntry[]) {
    if (!isDirectoryEntry(entry)) continue;
    if (!DESKTOP_PET_ID_PATTERN.test(entry.name)) continue;
    if (BUILTIN_DESKTOP_PET_IDS.has(entry.name)) continue;
    ids.push(entry.name);
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

function definitionFromRemoteManifest(
  id: string,
  manifest: RemotePetManifest,
  host: RemoteHost,
): DesktopPetDefinition | null {
  if (typeof manifest.id === 'string' && manifest.id !== id) return null;
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim()) return null;
  return {
    id,
    displayName: manifest.displayName.trim(),
    description: typeof manifest.description === 'string' ? manifest.description : '',
    glow: {
      primary: isHexColor(manifest.glow?.primary) ? manifest.glow.primary : DEFAULT_GLOW.primary,
      accent: isHexColor(manifest.glow?.accent) ? manifest.glow.accent : DEFAULT_GLOW.accent,
    },
    source: 'remote',
    previewUrl: petRawUrl(host, id, DESKTOP_PET_SPRITESHEET_NAME),
  };
}

async function fetchRemoteManifest(
  host: RemoteHost,
  id: string,
): Promise<DesktopPetDefinition | null> {
  try {
    const text = await fetchText(petRawUrl(host, id, DESKTOP_PET_MANIFEST_NAME), {
      maxBytes: DESKTOP_PET_MAX_MANIFEST_BYTES,
      accept: 'application/json,text/plain,*/*',
    });
    const manifest = JSON.parse(text) as RemotePetManifest;
    return definitionFromRemoteManifest(id, manifest, host);
  } catch {
    return null;
  }
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index]!);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

async function loadRemotePetsFromHost(
  host: RemoteHost,
  installedIds: ReadonlySet<string>,
): Promise<DesktopPetDefinition[]> {
  const dirs = await listPetDirectories(host);
  const pending = dirs.filter((id) => !installedIds.has(id));
  const fetched = await mapPool(pending, MANIFEST_CONCURRENCY, (id) =>
    fetchRemoteManifest(host, id),
  );
  return fetched.filter((pet): pet is DesktopPetDefinition => pet !== null);
}

/**
 * Discover community pets under repo `pets/` via Contents API + raw pet.json.
 * Prefer Gitee; fall back to GitHub when the whole Gitee path fails.
 */
export async function fetchRemoteDesktopPets(options: {
  installedIds: ReadonlySet<string>;
  force?: boolean;
}): Promise<{ pets: DesktopPetDefinition[]; source: RemoteHost | null; error?: string }> {
  if (!options.force && cachedRemote) {
    const pets = cachedRemote.pets.filter((pet) => !options.installedIds.has(pet.id));
    return { pets, source: cachedRemote.host };
  }

  const attempts: Array<{ host: RemoteHost; label: string }> = [
    { host: 'gitee', label: 'Gitee' },
    { host: 'github', label: 'GitHub' },
  ];
  const errors: string[] = [];

  for (const attempt of attempts) {
    try {
      const pets = await loadRemotePetsFromHost(attempt.host, options.installedIds);
      cachedRemote = { host: attempt.host, pets, fetchedAt: Date.now() };
      return { pets, source: attempt.host };
    } catch (reason) {
      errors.push(
        `${attempt.label}: ${reason instanceof Error ? reason.message : '请求失败'}`,
      );
    }
  }

  cachedRemote = null;
  return {
    pets: [],
    source: null,
    error: `社区宠物列表加载失败（${errors.join('；')}）`,
  };
}

export function clearRemoteDesktopPetCache(): void {
  cachedRemote = null;
}

async function downloadPetPackage(host: RemoteHost, id: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const manifest = await fetchBinary(
    petRawUrl(host, id, DESKTOP_PET_MANIFEST_NAME),
    DESKTOP_PET_MAX_MANIFEST_BYTES,
  );
  const spritesheet = await fetchBinary(
    petRawUrl(host, id, DESKTOP_PET_SPRITESHEET_NAME),
    DESKTOP_PET_MAX_SPRITESHEET_BYTES,
  );
  await writeFile(join(targetDir, DESKTOP_PET_MANIFEST_NAME), manifest);
  await writeFile(join(targetDir, DESKTOP_PET_SPRITESHEET_NAME), spritesheet);
}

async function resolveInstallHost(id: string): Promise<RemoteHost> {
  if (cachedRemote?.host) {
    const known = cachedRemote.pets.some((pet) => pet.id === id);
    if (known) return cachedRemote.host;
  }
  // Prefer Gitee; if the directory listing works there, use it for downloads too.
  try {
    const dirs = await listPetDirectories('gitee');
    if (dirs.includes(id)) return 'gitee';
  } catch {
    // fall through
  }
  const dirs = await listPetDirectories('github');
  if (!dirs.includes(id)) throw new Error(`远程仓库中未找到宠物 “${id}”`);
  return 'github';
}

async function installRemoteDesktopPetUnlocked(id: string, petsRoot: string): Promise<void> {
  if (!DESKTOP_PET_ID_PATTERN.test(id)) throw new Error('无效的宠物 id');
  if (BUILTIN_DESKTOP_PET_IDS.has(id)) throw new Error('不能覆盖内置宠物');

  const host = await resolveInstallHost(id);
  await mkdir(petsRoot, { recursive: true });
  const staging = join(petsRoot, `.tmp-${id}-${Date.now()}`);
  const destination = join(petsRoot, id);

  try {
    await downloadPetPackage(host, id, staging);
    await inspectDesktopPetPackage(staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (reason) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw reason instanceof Error ? reason : new Error('下载宠物失败');
  }
}

/** Download one community pet into `petsRoot/<id>/` after validation. */
export async function installRemoteDesktopPet(id: string, petsRoot: string): Promise<void> {
  const existing = installLocks.get(id);
  if (existing) {
    await existing;
    return;
  }
  const run = installRemoteDesktopPetUnlocked(id, petsRoot).finally(() => {
    installLocks.delete(id);
  });
  installLocks.set(id, run);
  await run;
}

/** Test helpers — keep remote URL builders consistent with production. */
export const __testing = {
  definitionFromRemoteManifest,
  isDirectoryEntry,
  petRawUrl,
  rawBase,
};
