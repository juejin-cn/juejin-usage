import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RouterError } from '../config.js';
import { RouterCredentialStore } from '../credential-store.js';
import { adapterPlans, defaultEnvironment, detectTool, INTEGRATION_TOOLS, resolveIntegrationPaths, type IntegrationChoice, type IntegrationEnvironment, type IntegrationTool, type ModelOption } from './adapters.js';
import { document, editValue, equal, readValue, type Format, type KeyPath, type Value } from './edit.js';
export type { IntegrationTool, IntegrationChoice, ModelOption } from './adapters.js';
export interface IntegrationContext { running: boolean; baseUrl: string | null; token: string; models: ModelOption[] }
interface Field { key: KeyPath; original: Value; last: Value }
interface ManagedFile { path: string; format: Format; originalText: string | null; lastText: string; fields: Field[] }
interface RecordState extends IntegrationChoice { files: ManagedFile[] }
interface Write { path: string; before: string | null; after: string | null }
interface State extends Record<string, unknown> { version: 1; tools: Partial<Record<IntegrationTool, RecordState>>; journal?: { id: IntegrationTool; writes: Write[]; next?: RecordState } }
export interface IntegrationStatus {
  id: IntegrationTool; name: string; icon: string; capability: 'automatic' | 'manual' | 'unsupported'; installed: boolean; enabled: boolean;
  state: 'connected' | 'stopped' | 'unconfigured' | 'missing' | 'manual' | 'unsupported' | 'conflict' | 'pending';
  mode: 'all' | 'custom'; models: string[]; defaultModel: string; error?: string;
}
const code = (error: unknown) => error instanceof RouterError ? error.code : 'INTEGRATION_WRITE_FAILED';
/** Never follow a config symlink or replace a file owned by another user. */
async function checkPath(file: string): Promise<void> {
  for (let current = resolve(file); ; current = dirname(current)) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (current === resolve(file) && (!info.isFile() || (process.getuid && info.uid !== process.getuid())))) throw new RouterError('INTEGRATION_PATH_UNSAFE', 409);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
async function read(file: string): Promise<string | null> {
  await checkPath(file);
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if ((await handle.stat()).size > 256 * 1024) throw new RouterError('INTEGRATION_CONFIG_TOO_LARGE', 409); return await handle.readFile('utf8'); }
    finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function write(change: Write) {
  if (await read(change.path) !== change.before) throw new RouterError('INTEGRATION_CONFLICT', 409);
  if (change.after === null) { await unlink(change.path).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
  await mkdir(dirname(change.path), { recursive: true, mode: 0o700 }); await checkPath(change.path);
  const temp = change.path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(change.after); await file.sync(); } finally { await file.close(); }
    if (await read(change.path) !== change.before) throw new RouterError('INTEGRATION_CONFLICT', 409);
    await rename(temp, change.path);
  } finally { await unlink(temp).catch(() => {}); }
}
export class AgentIntegrations {
  private state: State = { version: 1, tools: {} };
  private queue = Promise.resolve();
  private errors = new Map<IntegrationTool, string>();
  constructor(private store: RouterCredentialStore, private environment: IntegrationEnvironment = defaultEnvironment('')) {}
  private serial<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action); this.queue = next.then(() => {}, () => {}); return next; }
  private save() { return this.store.setDocument('agent-integrations-v1', this.state); }
  async init() {
    const saved = this.store.getDocument<State>('agent-integrations-v1');
    if (saved) {
      if (saved.version !== 1 || !saved.tools || typeof saved.tools !== 'object') throw new RouterError('INTEGRATION_STATE_INVALID', 409);
      this.state = saved;
    }
    if (this.state.journal) {
      try { await this.rollback(this.state.journal.writes); delete this.state.journal; await this.save(); }
      catch { this.errors.set(this.state.journal!.id, 'INTEGRATION_RECOVERY_CONFLICT'); }
    }
  }
  private async rollback(writes: Write[]) {
    let conflict = false;
    for (const change of [...writes].reverse()) {
      try {
        const current = await read(change.path);
        if (current === change.before) continue;
        if (current !== change.after) { conflict = true; continue; }
        await write({ path: change.path, before: current, after: change.before });
      } catch { conflict = true; }
    }
    if (conflict) throw new RouterError('INTEGRATION_RECOVERY_CONFLICT', 409);
  }
  private async transaction(id: IntegrationTool, writes: Write[], next?: RecordState) {
    if (this.state.journal) throw new RouterError('INTEGRATION_RECOVERY_CONFLICT', 409);
    const previous = structuredClone(this.state);
    this.state.journal = { id, writes, next };
    try { await this.save(); }
    catch (error) { this.state = previous; throw error; }
    try {
      for (const change of writes) if (change.before !== change.after) await write(change);
      if (next) this.state.tools[id] = next; else delete this.state.tools[id];
      delete this.state.journal; await this.save(); this.errors.delete(id);
    } catch (error) {
      this.state = { ...previous, journal: { id, writes, next } };
      try { await this.rollback(writes); this.state = previous; await this.save(); }
      catch { this.state.journal = { id, writes, next }; this.errors.set(id, 'INTEGRATION_RECOVERY_CONFLICT'); throw new RouterError('INTEGRATION_RECOVERY_CONFLICT', 409); }
      throw error;
    }
  }
  private selection(choice: IntegrationChoice, context: IntegrationContext): IntegrationChoice {
    const ids = context.models.map(m => m.id);
    const selected = choice.mode === 'all' ? ids : choice.models.filter(id => ids.includes(id));
    if (!selected.length) throw new RouterError('INTEGRATION_NO_MODELS', 409);
    return { mode: choice.mode, models: [...new Set(selected)], defaultModel: selected.includes(choice.defaultModel) ? choice.defaultModel : selected[0] };
  }
  private async apply(id: IntegrationTool, choice: IntegrationChoice, context: IntegrationContext) {
    const tool = INTEGRATION_TOOLS.find(t => t.id === id);
    if (!tool) throw new RouterError('INTEGRATION_UNKNOWN', 404);
    if (tool.capability !== 'automatic' || !['darwin', 'win32'].includes(this.environment.platform)) throw new RouterError('INTEGRATION_MANUAL_ONLY', 409);
    if (!context.running || !context.baseUrl || !context.token) throw new RouterError('GATEWAY_STOPPED', 409);
    const url = new URL(context.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1' || !url.port || url.search || url.hash || url.username) throw new RouterError('INTEGRATION_INVALID_URL');
    const paths = await resolveIntegrationPaths(this.environment);
    if (!await detectTool(id, this.environment, paths)) throw new RouterError('INTEGRATION_NOT_INSTALLED', 409);
    const previous = this.state.tools[id]; const selected = this.selection(choice, context);
    const plans = adapterPlans(id, paths, context.baseUrl, context.token, context.models.filter(m => selected.models.includes(m.id)), selected.defaultModel);
    if (previous && !equal(previous.files.map(f => f.path), plans.map(f => f.path))) throw new RouterError('INTEGRATION_PATH_CHANGED', 409);
    const files: ManagedFile[] = []; const writes: Write[] = [];
    for (const plan of plans) {
      const before = await read(plan.path); let after = before ?? (plan.format === 'json' ? '{}\n' : '');
      const parsed = document(after, plan.format);
      if (id === 'zcode' && plan.path.endsWith('provider_config.json') && parsed.schemaVersion !== undefined && parsed.schemaVersion !== 1) throw new RouterError('INTEGRATION_FORMAT_UNSUPPORTED', 409);
      const old = previous?.files.find(f => f.path === plan.path); const fields: Field[] = [];
      for (const field of plan.fields) {
        const current = readValue(parsed, field.key); const prior = old?.fields.find(f => equal(f.key, field.key));
        if (prior && !equal(prior.last, current)) throw new RouterError('INTEGRATION_CONFLICT', 409);
        const desired = { present: true, value: field.value };
        fields.push({ key: field.key, original: prior?.original ?? current, last: desired });
        after = editValue(after, plan.format, field.key, desired);
      }
      files.push({ ...plan, originalText: old ? old.originalText : before, lastText: after, fields });
      writes.push({ path: plan.path, before, after });
    }
    await this.transaction(id, writes, { ...selected, files });
  }
  update(id: IntegrationTool, input: unknown, context: IntegrationContext) {
    return this.serial(async () => {
      const choice = input as IntegrationChoice;
      if (!choice || !['all', 'custom'].includes(choice.mode) || !Array.isArray(choice.models) || choice.models.length > 4096 || choice.models.some(m => typeof m !== 'string' || m.length > 500) || typeof choice.defaultModel !== 'string') throw new RouterError('INTEGRATION_INVALID_SELECTION');
      if (choice.mode === 'custom' && choice.models.some(id => !context.models.some(m => m.id === id))) throw new RouterError('INTEGRATION_MODEL_UNAVAILABLE', 409);
      try { await this.apply(id, choice, context); }
      catch (error) { this.errors.set(id, code(error)); throw error; }
    });
  }
  remove(id: IntegrationTool) {
    return this.serial(async () => {
      if (!INTEGRATION_TOOLS.some(t => t.id === id)) throw new RouterError('INTEGRATION_UNKNOWN', 404);
      if (this.state.journal) {
        await this.rollback(this.state.journal.writes); delete this.state.journal; await this.save();
      }
      const record = this.state.tools[id]; if (!record) { this.errors.delete(id); return; }
      const writes: Write[] = [];
      try {
        for (const file of record.files) {
          const before = await read(file.path);
          // A file removed externally stays removed; unrelated files can still unwind.
          if (before === null) continue;
          const parsed = document(before, file.format);
          const baseline = document(file.originalText ?? '', file.format);
          const keepCodexProvider = id === 'codex' && file.format === 'toml'
            && !readValue(baseline, ['model_providers', 'jusage']).present;
          if (before === file.lastText && !keepCodexProvider && !(id === 'codex' && file.format === 'toml')) { writes.push({ path: file.path, before, after: file.originalText }); continue; }
          let after = before;
          for (const field of file.fields) {
            // Keep a complete provider for existing Codex sessions and profiles,
            // removing only the active reference on disconnect.
            if (keepCodexProvider && field.key[0] === 'model_providers') continue;
            // A tool's model switch or a user edit is not a reason to block the
            // entire disconnect. Restore only values that still belong to us.
            if (!equal(readValue(parsed, field.key), field.last)) continue;
            if (id === 'codex' && field.key.length === 1 && field.key[0] === 'model_catalog_json' && typeof field.original.value === 'string') {
              try { await lstat(resolve(dirname(file.path), field.original.value)); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                after = editValue(after, file.format, field.key, { present: false });
                continue;
              }
            }
            after = editValue(after, file.format, field.key, field.original);
          }
          writes.push({ path: file.path, before, after });
        }
        if (id === 'codex') {
          const config = record.files.find(file => file.format === 'toml');
          const catalog = record.files.find(file => file.format === 'json');
          if (config && catalog) {
            const remaining = writes.find(write => write.path === config.path)?.after ?? await read(config.path);
            // Profiles may still reference the managed catalog. Never remove a
            // catalog while the surviving config refers to it.
            const referencesCatalog = (value: unknown): boolean => {
              if (!value || typeof value !== 'object') return false;
              return Object.entries(value).some(([key, child]) =>
                key === 'model_catalog_json' && typeof child === 'string'
                  ? resolve(dirname(config.path), child) === resolve(catalog.path)
                  : referencesCatalog(child));
            };
            if (remaining && referencesCatalog(document(remaining, 'toml'))) {
              const index = writes.findIndex(write => write.path === catalog.path);
              if (index >= 0) writes.splice(index, 1);
            }
          }
        }
        await this.transaction(id, writes);
      } catch (error) { this.errors.set(id, code(error)); throw error; }
    });
  }
  sync(context: IntegrationContext) {
    return this.serial(async () => {
      if (!context.running) return;
      for (const id of Object.keys(this.state.tools) as IntegrationTool[]) {
        try { await this.apply(id, this.state.tools[id]!, context); }
        catch (error) { this.errors.set(id, code(error)); }
      }
    });
  }
  async flush() { await this.queue; }
  list(context: IntegrationContext): Promise<{ tools: IntegrationStatus[]; models: ModelOption[]; running: boolean; baseUrl: string | null }> {
    return this.serial(async () => {
      const paths = await resolveIntegrationPaths(this.environment);
      const tools: IntegrationStatus[] = [];
      for (const tool of INTEGRATION_TOOLS) {
        const record = this.state.tools[tool.id]; const installed = await detectTool(tool.id, this.environment, paths);
        let error = this.errors.get(tool.id);
        if (record && !error) for (const file of record.files) {
          try {
            const text = await read(file.path); const parsed = document(text ?? '', file.format);
            if (text === null || file.fields.some(f => !equal(f.last, readValue(parsed, f.key)))) { error = 'INTEGRATION_CONFLICT'; break; }
          } catch (cause) { error = code(cause); break; }
        }
        const capability = this.environment.platform === 'darwin' || this.environment.platform === 'win32' ? tool.capability : 'manual';
        const state = error ? /CONFLICT|PATH_CHANGED/.test(error) ? 'conflict' : 'pending' : record ? context.running ? 'connected' : 'stopped'
          : !installed ? 'missing' : capability === 'automatic' ? 'unconfigured' : capability;
        tools.push({ ...tool, capability, installed, enabled: !!record, state, mode: record?.mode ?? 'all', models: record?.models ?? context.models.map(m => m.id), defaultModel: record?.defaultModel ?? context.models[0]?.id ?? '', ...(error ? { error } : {}) });
      }
      return { tools, models: context.models, running: context.running, baseUrl: context.baseUrl };
    });
  }
}
