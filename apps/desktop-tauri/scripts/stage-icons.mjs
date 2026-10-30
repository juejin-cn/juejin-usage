import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep Electron as the single source for both application and template icons.
export function stageIcons() {
  const app = fileURLToPath(new URL('..', import.meta.url));
  const source = fileURLToPath(new URL('../../desktop/resources/', import.meta.url));
  const digest=createHash('sha256').update(readFileSync(join(source,'icon.png'))).digest('hex');
  const stamp=join(app,'src-tauri/icons/source.sha256');
  // tray-icon fixes macOS status item images at 18pt. Electron's 22pt asset
  // contains 20% padding, so using it here makes the mark visibly smaller.
  // Render the same vector without that padding at Retina resolution.
  const trayOutput = mkdtempSync(join(tmpdir(), 'jusage-tray-icon-'));
  try {
    const templateSvg = readFileSync(join(source, 'juejinTemplate.svg'), 'utf8');
    const padding = 'transform="translate(2.4 2.4) scale(.8)"';
    if (!templateSvg.includes(padding)) throw new Error('Unexpected tray icon source');
    const svg = templateSvg.replace(padding, '');
    const traySvg = join(trayOutput, 'tray.svg');
    writeFileSync(traySvg, svg);
    execFileSync(process.execPath, [join(app, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', traySvg, '--png', '38', '--output', trayOutput], { stdio: 'pipe' });
    cpSync(join(trayOutput, '38x38.png'), join(app, 'src-tauri/icons/tray-template.png'));
  } finally {
    rmSync(trayOutput, { recursive: true, force: true });
  }
  if(existsSync(stamp)&&readFileSync(stamp,'utf8').trim()===digest&&['icon.png','icon.ico','icon.icns'].every(name=>existsSync(join(app,'src-tauri/icons',name))))return;
  const output = mkdtempSync(join(tmpdir(), 'jusage-icons-'));
  try {
    execFileSync(process.execPath, [join(app, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', join(source, 'icon.png'), '--output', output], { stdio: 'pipe' });
    for (const name of ['icon.png', 'icon.ico', 'icon.icns']) cpSync(join(output, name), join(app, 'src-tauri/icons', name));
    writeFileSync(stamp,digest+'\n');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
