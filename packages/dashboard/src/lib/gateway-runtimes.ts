import { gatewayModelName } from '@juejin-opensource/jusage-core/agent-router/presets';
import type { ModelCatalog } from '@juejin-opensource/jusage-core/agent-router/model-metadata';
import type { IntegrationChoice, IntegrationStatus, IntegrationTool, ModelOption } from '@juejin-opensource/jusage-core/agent-router';
import { compareByPriority } from './compare-priority.ts';

export type RuntimeView = { tools: IntegrationStatus[]; models: ModelOption[]; running: boolean; baseUrl: string | null };
export const RUNTIME_TOOLS = [
  'claude', 'codex', 'deepseek-harness', 'claude-desktop', 'copilot-cli', 'gemini',
  'opencode', 'pi', 'kimi-code', 'minimax-code', 'qoder', 't3code', 'antigravity',
  'grok-build', 'omp', 'zcode',
] as const;
export const CLAUDE_RUNTIMES = [
  { id: 'claude', label: '终端' },
  { id: 'claude-vscode', label: 'VS Code 扩展' },
] as const;

/** Mainstream runtimes first within enabled / available groups. */
export const RUNTIME_TOOL_PRIORITY = [
  'claude', 'codex', 'deepseek-harness', 'claude-vscode', 'claude-desktop',
  'copilot-cli', 'gemini', 'opencode', 'pi', 'kimi-code', 'minimax-code', 'qoder',
  't3code', 'antigravity', 'grok-build', 'omp', 'zcode',
] as const;

export const isRuntimeTool = (id: IntegrationTool) => RUNTIME_TOOLS.some(tool => tool === id) || CLAUDE_RUNTIMES.some(tool => tool.id === id);

/** Show installed tools before onboarding, and retain configured tools for cleanup. */
export const isVisibleRuntimeTool = (tool: IntegrationStatus) => isRuntimeTool(tool.id) && (tool.installed || tool.enabled);

export function compareRuntimeToolPriority(a: IntegrationTool, b: IntegrationTool): number {
  return compareByPriority(a, b, RUNTIME_TOOL_PRIORITY);
}

/** Enabled tools first, then mainstream order within each group. */
export function compareRuntimeTools(a: Pick<IntegrationStatus, 'id' | 'enabled'>, b: Pick<IntegrationStatus, 'id' | 'enabled'>): number {
  return Number(b.enabled) - Number(a.enabled) || compareRuntimeToolPriority(a.id, b.id);
}

export function runtimeChoice(tool: IntegrationStatus, models: ModelOption[]): IntegrationChoice {
  const ids = new Set(models.map(model => model.id));
  const canonicalIds = new Map<string, string>();
  for (const model of models) {
    if (!canonicalIds.has(model.id)) canonicalIds.set(model.id, model.id);
    if (model.legacyId && !canonicalIds.has(model.legacyId)) canonicalIds.set(model.legacyId, model.id);
  }
  const currentId = (id: string) => canonicalIds.get(id) ?? id;
  const selected = tool.mode === 'all' ? models.map(model => model.id) : tool.models.map(currentId).filter(id => ids.has(id));
  const defaultModel = currentId(tool.defaultModel);
  const tierModels = tool.tierModels && Object.fromEntries(
    (['opus', 'sonnet', 'haiku', 'subagent'] as const)
      .filter(tier => tool.tierModels?.[tier] && selected.includes(currentId(tool.tierModels[tier]!)))
      .map(tier => [tier, currentId(tool.tierModels![tier]!)]),
  );
  return { mode: tool.mode, models: selected, defaultModel: selected.includes(defaultModel) ? defaultModel : selected[0] ?? '', ...(tierModels && Object.keys(tierModels).length ? { tierModels } : {}) };
}

export function runtimeSelectionError(view: RuntimeView, tool: IntegrationStatus, choice: IntegrationChoice): string | null {
  if (!view.running) return '请先启动网关，再接入工具。';
  if (!tool.installed) return '未检测到该工具，请安装或启动一次后刷新。';
  if (tool.capability !== 'automatic' && tool.id !== 'claude-desktop') return '此平台暂不支持自动配置。';
  const models = choice.mode === 'all' ? view.models.map(model => model.id) : choice.models;
  if (!models.length) return '请先登录供应商并开放模型。';
  const availableIds = new Set(view.models.map(model => model.id));
  if (models.some(id => !availableIds.has(id))) return '部分模型已不可用，请重新选择。';
  if (!models.includes(choice.defaultModel)) return '请选择一个可用的默认模型。';
  if (choice.tierModels && Object.values(choice.tierModels).some(id => id && !models.includes(id))) return '分模型设置包含不可用的模型，请重新选择。';
  return null;
}

export const RUNTIME_STATE_LABELS: Record<IntegrationStatus['state'], string> = {
  connected: '配置已接入', stopped: '网关未启动', unconfigured: '未接入', missing: '未安装',
  manual: '手动配置', unsupported: '暂不支持', conflict: '配置已变更', pending: '待同步',
};

/** Quick switching must never reconnect conflicted configs or change model scope. */
export function runtimeQuickSwitchError(view: RuntimeView, tool: IntegrationStatus, modelId: string): string | null {
  if (!tool.enabled) return '此工具尚未接入网关。';
  if (tool.state === 'conflict') return '工具配置已变更，请在主窗口确认后重新接入。';
  if (tool.capability !== 'automatic' || tool.id === 'claude-desktop') return '此工具需要手动配置，请在主窗口查看接入引导。';
  return runtimeSelectionError(view, tool, { ...runtimeChoice(tool, view.models), defaultModel: modelId });
}

/** Resolve display metadata by account and upstream ID without changing routing keys. */
export function runtimeModelName(model: ModelOption, catalogs: Record<string, ModelCatalog>): string {
  const source = model.legacyId;
  if (!source || source.startsWith('auto/')) return model.name;
  const separator = source.indexOf('/');
  if (separator < 1) return model.name;
  const catalog = catalogs[source.slice(0, separator)];
  const id = source.slice(separator + 1);
  return gatewayModelName(undefined, id, catalog?.metadata?.[id]?.name ?? catalog?.names?.[id], model.name);
}
