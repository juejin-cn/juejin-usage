import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DesktopPetCatalog, DesktopPetDefinition } from '../shared/desktop-pet-catalog.js';

const MANIFEST_NAME = 'pet.json';
const SPRITESHEET_NAME = 'spritesheet.webp';
const SPRITESHEET_WIDTH = 192 * 8;
const SPRITESHEET_HEIGHT = 208 * 11;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SPRITESHEET_BYTES = 12 * 1024 * 1024;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_GLOW = { primary: '#7c8cff', accent: '#69d4ff' };
export const BUILTIN_DESKTOP_PET_IDS: ReadonlySet<string> = new Set(['hawking', 'yoyo', 'click']);

interface PetManifest {
  id?: unknown;
  displayName?: unknown;
  description?: unknown;
  spriteVersionNumber?: unknown;
  spritesheetPath?: unknown;
  glow?: { primary?: unknown; accent?: unknown };
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function definitionFromManifest(manifest: PetManifest): DesktopPetDefinition {
  return {
    id: manifest.id as string,
    displayName: manifest.displayName as string,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    glow: {
      primary: isHexColor(manifest.glow?.primary) ? manifest.glow.primary : DEFAULT_GLOW.primary,
      accent: isHexColor(manifest.glow?.accent) ? manifest.glow.accent : DEFAULT_GLOW.accent,
    },
    source: 'local',
  };
}

/** Read the canvas size from a WebP RIFF container without relying on platform codecs. */
function readWebpDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 20 || data.subarray(0, 4).toString('ascii') !== 'RIFF' || data.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  for (let offset = 12; offset + 8 <= data.length;) {
    const type = data.subarray(offset, offset + 4).toString('ascii');
    const length = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + length > data.length) return null;
    if (type === 'VP8X' && length >= 10) {
      return {
        width: data.readUIntLE(body + 4, 3) + 1,
        height: data.readUIntLE(body + 7, 3) + 1,
      };
    }
    if (type === 'VP8 ' && length >= 10 && data[body + 3] === 0x9d && data[body + 4] === 0x01 && data[body + 5] === 0x2a) {
      return { width: data.readUInt16LE(body + 6) & 0x3fff, height: data.readUInt16LE(body + 8) & 0x3fff };
    }
    if (type === 'VP8L' && length >= 5 && data[body] === 0x2f) {
      return {
        width: 1 + data[body + 1]! + ((data[body + 2]! & 0x3f) << 8),
        height: 1 + (data[body + 2]! >> 6) + (data[body + 3]! << 2) + ((data[body + 4]! & 0x0f) << 10),
      };
    }
    offset = body + length + (length % 2);
  }
  return null;
}

async function inspectPet(directory: string): Promise<DesktopPetDefinition> {
  const manifestPath = join(directory, MANIFEST_NAME);
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) throw new Error(`缺少 ${MANIFEST_NAME}`);
  if (manifestStat.size > MAX_MANIFEST_BYTES) throw new Error(`${MANIFEST_NAME} 过大`);
  let manifest: PetManifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PetManifest; }
  catch { throw new Error(`${MANIFEST_NAME} 不是有效 JSON`); }
  if (manifest.spriteVersionNumber !== 2) throw new Error('仅支持 spriteVersionNumber: 2');
  if (typeof manifest.id !== 'string' || !ID_PATTERN.test(manifest.id)) throw new Error('id 必须是以小写字母开头的 1–64 位小写字母、数字或连字符');
  if (BUILTIN_DESKTOP_PET_IDS.has(manifest.id)) throw new Error(`id “${manifest.id}” 与内置宠物冲突`);
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim()) throw new Error('displayName 不能为空');
  if (manifest.spritesheetPath !== SPRITESHEET_NAME) throw new Error(`spritesheetPath 必须为 “${SPRITESHEET_NAME}”`);
  // The filename is fixed above; native path resolution also supports Windows separators.
  const spritesheetPath = resolve(directory, SPRITESHEET_NAME);
  if (!existsSync(spritesheetPath)) throw new Error(`缺少 ${SPRITESHEET_NAME}`);
  const spritesheetLinkStat = await lstat(spritesheetPath);
  const spritesheetStat = await stat(spritesheetPath);
  if (!spritesheetStat.isFile() || spritesheetLinkStat.isSymbolicLink() || spritesheetStat.size > MAX_SPRITESHEET_BYTES) throw new Error(`${SPRITESHEET_NAME} 无效或过大`);
  const size = readWebpDimensions(await readFile(spritesheetPath));
  if (!size || size.width !== SPRITESHEET_WIDTH || size.height !== SPRITESHEET_HEIGHT) throw new Error(`${SPRITESHEET_NAME} 必须为 ${SPRITESHEET_WIDTH}×${SPRITESHEET_HEIGHT} WebP 图集`);
  return definitionFromManifest(manifest);
}

/** Scan one directory without Electron dependencies or global catalog state. */
export async function scanDesktopPetDirectory(directory: string): Promise<{
  catalog: DesktopPetCatalog;
  spritesheets: Map<string, string>;
}> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  const pets: DesktopPetDefinition[] = [];
  const invalidPets: DesktopPetCatalog['invalidPets'] = [];
  const nextLocalPets = new Map<string, string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    try {
      const pet = await inspectPet(path);
      if (nextLocalPets.has(pet.id)) throw new Error(`id “${pet.id}” 重复`);
      nextLocalPets.set(pet.id, join(path, SPRITESHEET_NAME));
      pets.push(pet);
    } catch (error) {
      invalidPets.push({ directory: entry.name, reason: error instanceof Error ? error.message : '宠物包校验失败' });
    }
  }
  return { catalog: { pets, invalidPets, directory }, spritesheets: nextLocalPets };
}
