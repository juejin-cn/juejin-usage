import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

// The build-tool Node and the shipped sidecar Node are independent.
export function resolveNodeBinary(version, {
  env = process.env,
  execPath = process.execPath,
  currentVersion = process.versions.node,
  platform = process.platform,
  run = execFileSync,
} = {}) {
  if (env.TUD_NODE_BIN) return realpathSync(env.TUD_NODE_BIN);
  if (currentVersion === version) return realpathSync(execPath);
  // Custom ICU builds must always be selected explicitly, never downloaded.
  if (env.TUD_NODE_ICU === 'small' || env.TUD_NODE_BUILD_MANIFEST) {
    throw new Error('Custom Node builds require TUD_NODE_BIN');
  }
  console.log(`[desktop] Resolving sidecar Node ${version} via npm cache (build tools use ${currentVersion})…`);
  try {
    const output = run(platform === 'win32' ? 'npm.cmd' : 'npm', [
      'exec', '--yes', '--prefer-offline', `--package=node@${version}`,
      '--', 'node', '-p', 'process.execPath',
    ], {
      encoding: 'utf8',
      // Windows .cmd launchers require a shell; every argument above is fixed
      // or sourced from the repository's pinned .node-version.
      shell: platform === 'win32',
      env: { ...env, NODE_OPTIONS: '', NODE_ICU_DATA: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return realpathSync(output.trim());
  } catch (cause) {
    throw new Error(`Unable to obtain Node ${version}. Check npm registry access or set TUD_NODE_BIN to a matching local binary.`, { cause });
  }
}
