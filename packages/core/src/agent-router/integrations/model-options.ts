import type { ModelOption } from './adapters.js';
import { sanitizeModelMetadata } from '../model-metadata.js';

/** Keep unknown capabilities absent; a gateway does not add upstream capabilities. */
export function modelDetails(model: ModelOption) {
  const metadata = sanitizeModelMetadata(model.metadata);
  return { context: metadata.limits?.contextTokens, output: metadata.limits?.outputTokens, ...metadata.capabilities };
}

export function piModel(model: ModelOption) {
  const details = modelDetails(model);
  return {
    id: model.id, name: model.name,
    ...(details.context ? { contextWindow: details.context } : {}),
    ...(details.output ? { maxTokens: details.output } : {}),
    ...(details.vision !== undefined ? { input: details.vision ? ['text', 'image'] : ['text'] } : {}),
    ...(details.reasoning !== undefined ? { reasoning: details.reasoning } : {}),
  };
}
