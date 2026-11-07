import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RouterError } from './config.js';
import { FLEXIBLE_CLIENT_NPM, FLEXIBLE_CLIENT_PROTOCOL } from './integrations/protocol.js';

export const SESSION_AGENTS = { claude: 'messages', codex: 'responses', opencode: FLEXIBLE_CLIENT_PROTOCOL } as const;
export type SessionAgent = keyof typeof SESSION_AGENTS;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Disposable launchers only. Never reads or writes an agent's existing settings/auth files. */
export class AgentSessions {
  constructor(private directory: string) {}
  private async prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new RouterError('AGENT_SESSION_DIRECTORY_UNSAFE');
    await chmod(this.directory, 0o700);
  }
  async clear() {
    await this.prepare();
    for (const name of await readdir(this.directory)) {
      if (/^(?:claude\.json|(?:claude|codex|opencode)\.sh)(?:\.[a-f0-9-]{36})?$/.test(name)) {
        await unlink(join(this.directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
  async create(agent: SessionAgent, base: string, token: string, model: string) {
    if (process.platform === 'win32') throw new RouterError('AGENT_SESSION_UNSUPPORTED_PLATFORM');
    if (!Object.hasOwn(SESSION_AGENTS, agent)) throw new RouterError('AGENT_SESSION_UNKNOWN');
    const url = new URL(base);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1' || url.search || url.hash || url.username || url.password) throw new RouterError('AGENT_SESSION_INVALID_URL');
    if (!token || !model || /[\x00\r\n]/.test(token + model)) throw new RouterError('AGENT_SESSION_INVALID_INPUT');
    await this.prepare();
    let command: string;
    if (agent === 'claude') {
      const settings = JSON.stringify({ env: { ANTHROPIC_BASE_URL: base.replace(/\/v1$/, ''), ANTHROPIC_AUTH_TOKEN: token, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? 'true' }, model });
      await this.write(join(this.directory, 'claude.json'), settings, 0o600);
      command = `unset ANTHROPIC_API_KEY ANTHROPIC_MODEL CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY\nexec claude --settings ${quote(join(this.directory, 'claude.json'))} --model ${quote(model)}`;
    } else if (agent === 'codex') {
      const overrides = { model_provider: 'jusage_session', model, 'model_providers.jusage_session.name': 'Jusage temporary gateway', 'model_providers.jusage_session.base_url': base, 'model_providers.jusage_session.wire_api': 'responses', 'model_providers.jusage_session.env_key': 'JUSAGE_SESSION_KEY' };
      command = `export JUSAGE_SESSION_KEY=${quote(token)}\nexec codex ` + Object.entries(overrides).map(([key, value]) => '-c ' + quote(key + '=' + JSON.stringify(value))).join(' ');
    } else {
      const config = { provider: { jusage_session: { npm: FLEXIBLE_CLIENT_NPM, name: 'Jusage temporary gateway', options: { baseURL: base, apiKey: token }, models: { [model]: { name: model } } } }, model: 'jusage_session/' + model };
      command = `export OPENCODE_CONFIG_CONTENT=${quote(JSON.stringify(config))}\nexec opencode --model ${quote('jusage_session/' + model)}`;
    }
    const path = join(this.directory, agent + '.sh');
    await this.write(path, '#!/bin/sh\nset -eu\n' + command + '\n', 0o700);
    return { agent, command: quote(path), temporary: true };
  }
  private async write(path: string, content: string, mode: number) {
    const temporary = path + '.' + randomUUID();
    try {
      const file = await open(temporary, 'wx', mode);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
