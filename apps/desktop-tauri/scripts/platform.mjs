const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};
export function targetTriple(platform = process.platform, arch = process.arch, requested = process.env.TAURI_ENV_TARGET_TRIPLE) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported Tauri host: ${platform}/${arch}`);
  if (requested && requested !== target) throw new Error(`Cannot stage ${platform}/${arch} Node for ${requested}; build on a matching native runner`);
  return target;
}
export function externalNodeName(target = targetTriple(), platform = process.platform) {
  return `jusage-node-${target}${platform === 'win32' ? '.exe' : ''}`;
}
