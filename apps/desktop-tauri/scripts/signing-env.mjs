const notarizationKeys = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH'];
const signingKeys = ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_SIGNING_IDENTITY', ...notarizationKeys];

/** Tauri checks presence, not truthiness, before importing APPLE_CERTIFICATE. */
export function nativeBuildEnvironment(source = process.env, platform = process.platform, debug = false) {
  const env = { ...source };
  if (platform !== 'darwin') return env;
  if (debug || env.APPLE_SIGNING_IDENTITY === '-') {
    for (const key of signingKeys) delete env[key];
    env.APPLE_SIGNING_IDENTITY = '-';
    return env;
  }
  if (!env.APPLE_CERTIFICATE) {
    delete env.APPLE_CERTIFICATE;
    delete env.APPLE_CERTIFICATE_PASSWORD;
  } else {
    // An unencrypted PKCS#12 legitimately has an empty password. Tauri needs
    // the password variable to exist to select certificate import at all.
    env.APPLE_CERTIFICATE_PASSWORD ??= '';
  }
  if (!env.APPLE_SIGNING_IDENTITY) delete env.APPLE_SIGNING_IDENTITY;
  for (const key of notarizationKeys) if (!env[key]) delete env[key];
  if (!env.APPLE_SIGNING_IDENTITY && !env.APPLE_CERTIFICATE) env.APPLE_SIGNING_IDENTITY = '-';
  return env;
}
