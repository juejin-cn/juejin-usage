import type { IntegrationChoice, IntegrationStatus, IntegrationTool, ModelOption } from '@juejin-opensource/jusage-core/agent-router';

export type RuntimeView = { tools: IntegrationStatus[]; models: ModelOption[]; running: boolean; baseUrl: string | null };
export const RUNTIME_TOOLS = ['claude', 'claude-desktop', 'codex', 'gemini', 'zcode', 'minimax-code', 'pi', 'opencode', 'deepseek-harness'] as const;
export const CLAUDE_RUNTIMES = [
  { id: 'claude', label: '终端' },
  { id: 'claude-vscode', label: 'VS Code 扩展' },
] as const;
export const isRuntimeTool = (id: IntegrationTool) => RUNTIME_TOOLS.some(tool => tool === id) || CLAUDE_RUNTIMES.some(tool => tool.id === id);

export function runtimeChoice(tool: IntegrationStatus, models: ModelOption[]): IntegrationChoice {
  const ids = new Set(models.map(model => model.id));
  const currentId = (id: string) => models.find(model => model.id === id || model.legacyId === id)?.id ?? id;
  const selected = tool.mode === 'all' ? models.map(model => model.id) : tool.models.map(currentId).filter(id => ids.has(id));
  const defaultModel = currentId(tool.defaultModel);
  return { mode: tool.mode, models: selected, defaultModel: selected.includes(defaultModel) ? defaultModel : selected[0] ?? '' };
}

export function runtimeSelectionError(view: RuntimeView, tool: IntegrationStatus, choice: IntegrationChoice): string | null {
  if (!view.running) return '请先启动网关，再接入工具。';
  if (!tool.installed) return '未检测到该工具，请安装或启动一次后刷新。';
  if (tool.capability !== 'automatic' && tool.id !== 'claude-desktop') return '此平台暂不支持自动配置。';
  const models = choice.mode === 'all' ? view.models.map(model => model.id) : choice.models;
  if (!models.length) return '请先登录供应商并开放模型。';
  if (models.some(id => !view.models.some(model => model.id === id))) return '部分模型已不可用，请重新选择。';
  if (!models.includes(choice.defaultModel)) return '请选择一个可用的默认模型。';
  return null;
}

export const RUNTIME_STATE_LABELS: Record<IntegrationStatus['state'], string> = {
  connected: '配置已接入', stopped: '网关未启动', unconfigured: '未接入', missing: '未安装',
  manual: '手动配置', unsupported: '暂不支持', conflict: '配置已变更', pending: '待同步',
};
