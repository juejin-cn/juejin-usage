import { readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { RouterError } from '../config.js';
import { document, readValue, type KeyPath } from './edit.js';
import type { FilePlan, IntegrationEnvironment } from './adapters.js';
import type { ToolInstallation } from './detection.js';
import { messagesBaseUrl } from './protocol.js';

type Read = (file: string) => Promise<string | null>;
const keyRef = 'JUSAGE_GATEWAY_KEY';
const row = (id: string) => ({ field: 'id', value: id });

/** Follow an explicit DSH_HOME, including the literal home in a desktop CLI shim.
 * Never execute a launcher or expand shell expressions while detecting paths. */
export async function harnessHome(environment: IntegrationEnvironment, installation: ToolInstallation, read: Read): Promise<string> {
  const p = environment.platform === 'win32' ? path.win32 : path.posix;
  let value = environment.env.DSH_HOME?.trim() || undefined;
  if (!value && installation.kind === 'cli') {
    let launcher = '';
    try { launcher = await read(installation.path) ?? ''; } catch { /* A normal npm symlink uses the default home. */ }
    if (launcher.includes('DeepSeek Harness Desktop')) {
      value = /^export DSH_HOME=(?:'([^'\r\n]+)'|"([^"$`\r\n]+)")\s*$/m.exec(launcher)?.slice(1).find(Boolean);
    }
  }
  if (!value) return p.join(environment.home, '.dsh');
  if (value.startsWith('~/') || value.startsWith('~\\')) value = p.join(environment.home, value.slice(2));
  if (!p.isAbsolute(value)) throw new RouterError('INTEGRATION_PATH_UNSUPPORTED', 409);
  return value;
}

export async function harnessPlans(environment: IntegrationEnvironment, installation: ToolInstallation, read: Read,
  base: string, token: string, models: Array<{ id: string; name: string }>, defaultModel: string): Promise<FilePlan[]> {
  const p = environment.platform === 'win32' ? path.win32 : path.posix;
  const primary = await harnessHome(environment, installation, read);
  const homes = [primary]; const shared = p.join(environment.home, '.dsh');
  // An old third-party CLI shim can coexist with the official Desktop app.
  // Its private home must not hide an initialized official Desktop profile.
  if (!environment.env.DSH_HOME?.trim() && primary !== shared) {
    const manifest = await read(p.join(shared, 'profiles', 'desktop', 'package.json'));
    if (manifest !== null) {
      const profile = document(manifest, 'json');
      if (Array.isArray(profile.dsh?.profile?.bundles) && profile.dsh.profile.bundles.includes('@deepseek-ai/dsh-base')) homes.push(shared);
    }
  }
  const plans: FilePlan[] = [];
  for (const home of homes) plans.push(...await plansForHome(home, p, read, base, token, models, defaultModel));
  return plans;
}

async function plansForHome(home: string, p: typeof path.posix, read: Read,
  base: string, token: string, models: Array<{ id: string; name: string }>, defaultModel: string): Promise<FilePlan[]> {
  const profiles = p.join(home, 'profiles');
  const names = new Set(['web', 'desktop']);
  try {
    for (const entry of await readdir(profiles, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) throw new RouterError('INTEGRATION_PATH_UNSAFE', 409);
      if (entry.isDirectory()) {
        const patch = p.join(profiles, entry.name, 'cordis.patch.yml');
        if (await read(patch) !== null || await read(p.join(profiles, entry.name, 'package.json')) !== null) names.add(entry.name);
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (names.size > 64) throw new RouterError('INTEGRATION_CONFIG_TOO_LARGE', 409);
  const paths = [...names].sort().map(name => p.join(profiles, name, 'cordis.patch.yml'));
  // The home patch is a later layer. Update it only where it already overrides
  // these rows; otherwise let each profile keep its own provider settings.
  const homePatch = p.join(home, 'cordis.patch.yml');
  const homeText = await read(homePatch);
  const homeRows = homeText === null ? [] : document(homeText, 'yaml-sequence');
  const plans: FilePlan[] = [];
  for (const file of [...paths, ...(homeText !== null ? [homePatch] : [])]) {
    const isHome = file === homePatch;
    const text = isHome ? homeText : await read(file);
    const parsed = text === null ? [] : document(text, 'yaml-sequence');
    const fields: FilePlan['fields'] = []; const cleanup: KeyPath[] = [];
    for (const [id, plugin] of [['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'], ['agent-default-model', '@deepseek-ai/dsh-agent-default-model']]) {
      const selector = row(id); const current = readValue(parsed, [selector]);
      if (isHome && !readValue(homeRows, [selector]).present) continue;
      if (current.present && (typeof current.value !== 'object' || !current.value)) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
      const existing = current.value as Record<string, unknown> | undefined;
      if (existing?.name !== undefined && existing.name !== plugin) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
      fields.push({ key: [selector, 'name'], value: plugin });
      if (id === 'llm-pi-ai') {
        // Harness selects the wire protocol per provider, not per model.
        // Keep both catalogs available so switching protocols never changes
        // the gateway model ID. Anthropic's SDK appends /v1/messages itself.
        for (const [provider, api, baseURL] of [
          ['jusage', 'anthropic-messages', messagesBaseUrl(base)],
          ['jusage-responses', 'openai-responses', base],
        ]) fields.push({ key: [selector, 'config', 'providers', provider], value: {
          displayName: provider === 'jusage' ? 'jusage · Claude Messages' : 'jusage · OpenAI Responses',
          api, baseURL, apiKeyEnv: keyRef,
          models: models.map(model => ({ id: model.id, name: model.name })),
        } });
      }
      else fields.push({ key: [selector, 'config', 'provider'], value: /(?:^|\/)(?:gpt-|chatgpt-|codex(?:-|$)|o[134](?:-|$))/i.test(defaultModel) ? 'jusage-responses' : 'jusage' }, { key: [selector, 'config', 'model'], value: defaultModel }, { key: [selector, 'config', 'reasoningEffort'], value: undefined });
      cleanup.push([selector, 'config', 'providers'], [selector, 'config'], [selector]);
    }
    if (fields.length) plans.push({ path: file, format: 'yaml-sequence', fields, cleanup });
  }
  const credentials = p.join(home, '.credentials.yaml');
  const saved = await read(credentials); const schema = document(saved ?? '', 'yaml');
  // Released desktop bundles still use the original flat credential map. Read
  // the installed parser as bounded text, never import or execute its code.
  let runtimeLayout: 'flat' | 'versioned' | undefined;
  const parserPath = p.join(profiles, 'node_modules', '@deepseek-ai', 'dsh-credentials-local', 'lib', 'index.js');
  try {
    const handle = await open(parserPath, 'r');
    try {
      if ((await handle.stat()).size <= 256 * 1024) {
        const source = await handle.readFile('utf8');
        if (source.includes('mapping of credential reference to value') && source.includes('typeof value !==')) runtimeLayout = 'flat';
        else if (source.includes('DOCUMENT_VERSION') && source.includes('parseCredentialsDocument')) runtimeLayout = 'versioned';
      }
    } finally { await handle.close(); }
  } catch { /* No installed parser: follow an existing schema, otherwise v1. */ }
  const entries = Object.entries(schema);
  const flat = entries.length > 0 && entries.every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && value.length > 0);
  // The store currently used by an application is authoritative. Shared
  // node_modules may still point at an older desktop/CLI installation.
  const layout = entries.length ? (flat ? 'flat' : 'versioned') : runtimeLayout ?? 'versioned';
  if (entries.length && (layout === 'flat' ? !flat : schema.version !== 1)) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
  if (layout === 'flat') plans.push({ path: credentials, format: 'yaml', fields: [{ key: [keyRef], value: token }] });
  else {
    if (schema.refs !== undefined && (!schema.refs || typeof schema.refs !== 'object' || Array.isArray(schema.refs))) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
    plans.push({ path: credentials, format: 'yaml', fields: [
      { key: ['version'], value: 1 }, { key: ['refs', keyRef], value: token },
      { key: ['records', 'llm-pi-ai/jusage'], value: { kind: 'api-key', key: token } },
      { key: ['records', 'llm-pi-ai/jusage-responses'], value: { kind: 'api-key', key: token } },
    ], cleanup: [['refs'], ['records']] });
  }
  plans.push({ path: p.join(home, '.env'), format: 'dotenv', fields: [{ key: [keyRef], value: token }] });
  return plans;
}
