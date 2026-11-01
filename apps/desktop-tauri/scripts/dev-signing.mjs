import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';

const identifier = 'com.juejin.jusage.desktop-tauri';

export function selectDevelopmentIdentity(output) {
  const identities = [...output.matchAll(/\b([A-Fa-f0-9]{40})\s+"([^"]+)"/g)]
    .map(([, hash, name]) => ({ hash, name }))
    .filter(({ name }) => /^(Apple Development|Mac Developer|Developer ID Application):/.test(name));
  identities.sort((a, b) => Number(!/^(Apple Development|Mac Developer):/.test(a.name)) - Number(!/^(Apple Development|Mac Developer):/.test(b.name)) || a.name.localeCompare(b.name) || a.hash.localeCompare(b.hash));
  return identities[0]?.hash;
}

/** Keep macOS keychain trust tied to a certificate, rather than each rebuilt executable's cdhash. */
export function developmentSigning(source = process.env, platform = process.platform, readIdentities = () => execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), node = process.execPath, runner = fileURLToPath(import.meta.url)) {
  const env = { ...source };
  if (platform !== 'darwin' || env.TUD_DEV_SIGNING_IDENTITY === '-') return { env, args: [] };
  let identity = env.TUD_DEV_SIGNING_IDENTITY || (env.APPLE_SIGNING_IDENTITY !== '-' ? env.APPLE_SIGNING_IDENTITY : undefined);
  if (!identity) {
    try { identity = selectDevelopmentIdentity(readIdentities()); } catch { /* A machine without a signing identity keeps the existing dev workflow. */ }
  }
  if (!identity) return { env, args: [] };
  env.TUD_DEV_SIGNING_IDENTITY = identity;
  // Structured Cargo --config arguments support paths with spaces without a shell.
  const command = JSON.stringify([node, runner]);
  const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].filter(target => !env[`CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_RUNNER`]);
  const args = targets.flatMap(target => ['--config', `target.${target}.runner=${command}`]);
  return { env, args: args.length ? ['--', ...args] : [] };
}

export function signDevelopmentBinary(binary, identity, run = execFileSync) {
  if (!identity || identity === '-') throw new Error('A stable development signing identity is required');
  run('codesign', ['--force', '--sign', identity, '--identifier', identifier, '--timestamp=none', binary], { stdio: 'inherit' });
  run('codesign', ['--verify', '--strict', binary], { stdio: 'inherit' });
}

async function runBinary() {
  const [binary, ...args] = process.argv.slice(2);
  if (!binary) throw new Error('Cargo did not supply the executable');
  signDevelopmentBinary(binary, process.env.TUD_DEV_SIGNING_IDENTITY);
  const child = spawn(binary, args, { stdio: 'inherit' });
  const forward = signal => { if (child.exitCode === null) child.kill(signal); };
  const interrupt = () => forward('SIGINT'); const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 1))); });
    process.exitCode = result;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBinary().catch(error => { console.error(`[tud-desktop] ${error.message}`); process.exitCode = 1; });
}
