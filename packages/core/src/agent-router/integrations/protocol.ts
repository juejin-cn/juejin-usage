import { preferredClientProtocol } from '../protocol-preference.js';
export { preferredClientProtocol, CLIENT_PROTOCOL_PRIORITY } from '../protocol-preference.js';

/** Client-side preference only. Provider transports continue using the
 * upstream model's actual native protocol, independent of the client. */
export const FLEXIBLE_CLIENT_PROTOCOL = preferredClientProtocol(['messages', 'responses', 'chat']);
export const messagesBaseUrl = (base: string) => base.replace(/\/v1\/?$/, '');
export const FLEXIBLE_CLIENT_API = { messages: 'anthropic-messages', responses: 'openai-responses', chat: 'openai-completions' }[FLEXIBLE_CLIENT_PROTOCOL];
export const FLEXIBLE_CLIENT_NPM = { messages: '@ai-sdk/anthropic', responses: '@ai-sdk/openai', chat: '@ai-sdk/openai-compatible' }[FLEXIBLE_CLIENT_PROTOCOL];
export const FLEXIBLE_CLIENT_KIND = { messages: 'anthropic', responses: 'openai', chat: 'openai-compatible' }[FLEXIBLE_CLIENT_PROTOCOL];
export const FLEXIBLE_CLIENT_RULE = { messages: 'anthropic-messages', responses: 'openai-responses', chat: 'openai-chat-completions' }[FLEXIBLE_CLIENT_PROTOCOL];
export const flexibleClientBaseUrl = (base: string) => FLEXIBLE_CLIENT_PROTOCOL === 'messages' ? messagesBaseUrl(base) : base;
