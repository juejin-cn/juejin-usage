import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep Electron as the single source for both application and template icons.
export function stageIcons() {
  const app = fileURLToPath(new URL('..', import.meta.url));
  const source = fileURLToPath(new URL('../../desktop/resources/', import.meta.url));
  const output = mkdtempSync(join(tmpdir(), 'jusage-icons-'));
  try {
    execFileSync(process.execPath, [join(app, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', join(source, 'icon.png'), '--output', output], { stdio: 'pipe' });
    for (const name of ['icon.png', 'icon.ico', 'icon.icns']) cpSync(join(output, name), join(app, 'src-tauri/icons', name));
    cpSync(join(source, 'juejinTemplate.png'), join(app, 'src-tauri/icons/tray-template.png'));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
