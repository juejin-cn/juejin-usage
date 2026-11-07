import { boot, shutdown } from './runtime.js';
import { readHostBootstrap } from './vault-bootstrap.js';

let stopping = false;
async function stop(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 5_000);
  deadline.unref();
  try { await startup.catch(() => {}); await shutdown(); } finally { process.exit(code); }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
// Rust owns stdin. EOF also works on Windows and when the host is force-killed.
process.stdin.resume();
process.stdin.on('end', () => void stop());
process.stdin.on('data', (data: Buffer) => {
  if (data.toString().includes('shutdown')) void stop();
});
const startup = (async () => {
  const secrets = await readHostBootstrap(process.stdin, process.env.TUD_VAULT_PIPE === '1');
  try { await boot(secrets); } finally { secrets.vaultKey?.fill(0); }
})();
startup.catch((err) => {
  console.error('[desktop-tauri] boot failed:', err instanceof Error ? err.message : err);
  void stop(1);
});
