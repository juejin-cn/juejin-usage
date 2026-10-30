import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

/** Only operate on the staged copy, before Tauri applies the bundle signature. */
export function optimizeNodeBinary(binary) {
  if (process.platform !== 'darwin') return;
  const before = statSync(binary).size;
  // Remove local symbols, retaining exported symbols used by native modules.
  // Never strip the build machine's Node installation or use runtime packers.
  execFileSync('xcrun', ['strip', '-x', binary], { stdio: 'pipe' });
  // arm64 needs a valid signature even for the pre-bundle runtime smoke test.
  // The final bundle is signed again with the configured release identity.
  execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'pipe' });
  execFileSync(binary, ['--version'], { stdio: 'pipe' });
  const after = statSync(binary).size;
  console.log(`Staged Node symbols removed: ${(before / 1024 ** 2).toFixed(2)} → ${(after / 1024 ** 2).toFixed(2)} MiB`);
}
