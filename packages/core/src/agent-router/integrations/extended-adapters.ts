import { piModel, modelDetails } from './model-options.js';
import type { FilePlan, IntegrationTool, ModelOption, resolveIntegrationPaths } from './adapters.js';
import type { KeyPath } from './edit.js';
import { FLEXIBLE_CLIENT_API, flexibleClientBaseUrl, messagesBaseUrl } from './protocol.js';

export function extendedAdapterPlans(id: IntegrationTool, paths: Awaited<ReturnType<typeof resolveIntegrationPaths>>, base: string, token: string, models: ModelOption[], selected: string): FilePlan[] | null {
  const field = (key: KeyPath, value: unknown) => ({ key, value });
  const ref = 'jusage/' + selected;
  if (id === 't3code') return [{ path: paths.t3code, format: 'json', fields: [
    field(['providerInstances', 'jusage', 'driver'], 'claudeAgent'),
    field(['providerInstances', 'jusage', 'displayName'], 'jusage'),
    field(['providerInstances', 'jusage', 'enabled'], true),
    field(['providerInstances', 'jusage', 'config', 'customModels'], models.map(m => ({ slug: m.id, name: m.name }))),
    ...Object.entries({ ANTHROPIC_BASE_URL: messagesBaseUrl(base), ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: selected, ANTHROPIC_DEFAULT_OPUS_MODEL: selected, ANTHROPIC_DEFAULT_SONNET_MODEL: selected, ANTHROPIC_DEFAULT_HAIKU_MODEL: selected, CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' }).map(([name, value]) => field(['providerInstances', 'jusage', 'environment', { field: 'name', value: name }], { name, value, sensitive: name === 'ANTHROPIC_AUTH_TOKEN' })),
  ], cleanup: [['providerInstances', 'jusage', 'config'], ['providerInstances', 'jusage']] }];
  if (id === 'antigravity') return [paths.antigravity, paths.antigravityLegacy].map(path => ({ path, format: 'json', fields: [
    ...Object.entries({ enabled: true, url: messagesBaseUrl(base), apiKey: token, wireProtocol: 'openai' }).map(([key, value]) => field(['gateway', key], value)),
    field(['models', 'defaultModelId'], selected), field(['models', 'list'], models.map(m => ({ modelId: m.id }))), field(['models', 'listSource'], undefined),
  ], cleanup: [['gateway'], ['models']] }));
  if (id === 'copilot-cli') return [
    { path: paths.copilotProviders, format: 'json', fields: [
      field(['providers', { field: 'name', value: 'jusage' }], { name: 'jusage', type: 'openai', baseUrl: base, apiKey: token }),
      ...models.map(m => field(['models', { field: 'id', value: m.id, where: { provider: 'jusage' } }], copilotModel(m))),
    ] },
    { path: paths['copilot-cli'], format: 'json', fields: [field(['model'], ref)] },
  ];
  if (id === 'omp') return [
    { path: paths.ompModels, format: 'yaml', fields: [field(['providers', 'jusage'], { baseUrl: flexibleClientBaseUrl(base), api: FLEXIBLE_CLIENT_API, apiKey: token, models: models.map(piModel) })] },
    { path: paths.omp, format: 'yaml', fields: [field(['modelRoles', 'default'], ref), field(['enabledModels'], models.map(m => 'jusage/' + m.id))] },
  ];
  if (id === 'qoder') return [{ path: paths.qoder, format: 'json', fields: [
    ...Object.entries({ displayName: 'jusage', protocol: 'openai', baseUrl: base, apiKey: token, model: selected, models: models.map(m => (qoderModel(m))) }).map(([key, value]) => field(['providers', 'jusage', key], value)),
    field(['model', 'name'], ref),
  ], cleanup: [['providers', 'jusage']] }];
  if (id === 'kimi-code') return [{ path: paths['kimi-code'], format: 'toml', fields: [
    ...Object.entries({ type: 'kimi', base_url: base, api_key: token }).map(([key, value]) => field(['providers', 'jusage', key], value)),
    ...models.map(m => field(['models', 'jusage/' + m.id], kimiModel(m, paths['kimi-code'] === paths.kimiLegacy))),
    field(['default_model'], ref),
  ] }];
  if (id === 'grok-build') return [{ path: paths['grok-build'], format: 'toml', fields: [
    ...models.map(m => field(['model', 'jusage/' + m.id], { model: m.id, name: m.name, base_url: base, api_key: token, api_backend: 'chat_completions', ...(modelDetails(m).context ? { context_window: modelDetails(m).context } : {}) })),
    field(['models', 'default'], ref), field(['features', 'campaigns'], false),
  ] }];
  return null;
}

function copilotModel(model: ModelOption) {
  const { context, output } = modelDetails(model);
  return { id: model.id, provider: 'jusage', name: model.name,
    ...(output ? { maxOutputTokens: output } : {}),
    ...(context ? { maxContextWindowTokens: context, maxPromptTokens: output && output < context ? context - output : context } : {}),
  };
}
function qoderModel(model: ModelOption) {
  const { context, output, vision, toolCalling } = modelDetails(model);
  return { model: model.id, displayName: model.name,
    capabilities: { tools: toolCalling ?? true, ...(vision !== undefined ? { vision } : {}) },
    ...(context ? { contextWindow: context } : {}), ...(output ? { maxOutputTokens: output } : {}),
  };
}
function kimiModel(model: ModelOption, legacy: boolean) {
  const { context, output, vision, toolCalling } = modelDetails(model);
  const capabilities = [...(vision ? ['image_in'] : []), ...(!legacy && toolCalling !== false ? ['tool_use'] : [])];
  return { provider: 'jusage', model: model.id, display_name: model.name, max_context_size: context ?? 128000,
    ...(capabilities.length ? { capabilities } : {}), ...(!legacy && output ? { max_output_size: output } : {}),
  };
}
