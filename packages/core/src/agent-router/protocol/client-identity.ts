/** Closed, client-owned identity introductions. Providers with a restricted
 * assistant identity can opt into this normalization at their transport edge.
 * Never apply it to user messages or arbitrary occurrences of vendor names. */
const CODEX_IDENTITY = 'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.';
const IDENTITIES = [
  'You are an AI agent powered by DeepSeek Harness.',
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are Claude Code, Anthropic's official CLI for Claude.",
  CODEX_IDENTITY,
];
export const PORTABLE_CLIENT_IDENTITY = "You are an AI coding assistant running in the user's local CLI.";
export function portableClientIdentity(text: string): string {
  const identity = IDENTITIES.find(prefix => text === prefix || text.startsWith(prefix + '\n') || text.startsWith(prefix + '\r\n') || prefix === CODEX_IDENTITY && text.startsWith(prefix + ' '));
  return identity ? PORTABLE_CLIENT_IDENTITY + text.slice(identity.length) : text;
}
