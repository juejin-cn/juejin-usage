import type { RouterCredentials } from './auth.js';
import { exposedModels, type AgentRouterConfig } from './config.js';
import { openTransport } from './transport.js';
import { convertReply } from './protocol/index.js';
import { replyJson, type SearchHit, type WebSearchExecutor } from './protocol/hosted-tools.js';
import type { Wire } from './protocol/request.js';

/** A search backend is selected by its native wire capability, never by the
 * requesting client's channel. It receives no conversation or credentials
 * belonging to the requesting provider. */
export function nativeWebSearch(config: AgentRouterConfig, credentials: RouterCredentials, port: number,
  admit?: (providerId: string, signal: AbortSignal) => Promise<() => void>): WebSearchExecutor {
  return async (query, options, signal) => {
    const providers = config.providers.filter(p => p.enabled && p.protocol === 'responses' && credentials.ready(p) && exposedModels(p).length).slice(0, 3);
    for (const provider of providers) {
      signal.throwIfAborted();
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
      let release: (() => void) | undefined;
      try {
        release = await admit?.(provider.id, bounded);
        const tool: Wire = { type: 'web_search' };
        for (const key of ['filters', 'user_location', 'search_context_size', 'external_web_access']) if (options[key] !== undefined) tool[key] = options[key];
        // Translate domain constraints by meaning, not by provider identity.
        if (options.allowed_domains) tool.filters = { ...tool.filters, allowed_domains: options.allowed_domains };
        const reply = await openTransport(credentials, provider, { model: exposedModels(provider)[0], input: query,
          instructions: 'Search the web for the given query. Return concise factual findings with source URLs. Use the search tool before answering.',
          tools: [tool], tool_choice: { type: 'web_search' }, include: ['web_search_call.action.sources'], max_output_tokens: 2048, stream: true, store: false }, bounded, port);
        if (reply.status < 200 || reply.status >= 300) { reply.dispose(); continue; }
        const result = await replyJson(convertReply(reply, 'responses', 'responses', query, false, bounded), bounded);
        const output: Wire[] = Array.isArray(result.output) ? result.output : [];
        if (!output.some(i => i.type === 'web_search_call' && i.status === 'completed')) continue;
        const sources = new Map<string, SearchHit>(); const texts: string[] = [];
        const add = (s: Wire) => {
          try {
            const url = new URL(s.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
            const allowed = options.filters?.allowed_domains ?? options.allowed_domains;
            const denied = options.blocked_domains;
            const matches = (domain: string) => url.hostname === domain || url.hostname.endsWith('.' + domain);
            if (Array.isArray(allowed) && !allowed.some(matches) || Array.isArray(denied) && denied.some(matches)) return;
            sources.set(url.href, { title: String(s.title || url.hostname).slice(0, 1000), url: url.href, ...(s.snippet ? { snippet: String(s.snippet).slice(0, 4000) } : {}) });
          } catch { /* Invalid provider citations are not presented as URLs. */ }
        };
        for (const item of output) {
          for (const source of item.action?.sources ?? []) add(source);
          for (const part of item.content ?? []) {
            if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
            for (const citation of part.annotations ?? []) if (citation.type === 'url_citation') add(citation);
          }
        }
        if (!sources.size) continue;
        return { text: texts.join('\n').slice(0, 24000), sources: [...sources.values()].slice(0, 20) };
      } catch { signal.throwIfAborted(); }
      finally { release?.(); }
    }
    return { text: 'No connected search-capable backend completed a web search. Do not claim to have searched or invent current facts. You may use existing sources or explain that web search is unavailable.', sources: [], error: 'SEARCH_UNAVAILABLE' };
  };
}
