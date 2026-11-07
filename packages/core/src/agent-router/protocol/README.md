# Gateway protocol conversion

The gateway keeps the client protocol separate from the provider's native protocol.
All twelve directions between Chat Completions, Responses, Anthropic Messages and
Gemini GenerateContent are available within the explicit compatibility boundaries. Native payload bytes are preserved after transfer decompression, except for
client search adaptation and JSON/SSE conversion described below. No third-party runtime
or additional HTTP proxy is required.

## Design and open-source references

This is an independent TypeScript implementation using normalized request data
(Chat-shaped messages) and protocol-neutral response events. Architectural references:

- [@musistudio/llms](https://github.com/musistudio/llms): its package declares MIT;
  modular transformers around unified requests/responses. The published entry point
  is a server, so it is not added as a second server/runtime dependency here.
- [LiteLLM](https://github.com/BerriAI/litellm): another full proxy with protocol
  adapters; its root license is MIT outside the separately licensed enterprise code.

No code from those implementations is vendored by this converter.

## Stream-only subscriptions

The transport marks WorkBuddy and WorkBuddy AI subscriptions as requiring upstream
streaming, independent of the client protocol. It copies the upstream body with
`stream: true`; the original client flag is preserved. SSE collection also runs
when both protocols are the same. The worker still rejects direct non-streaming
calls as an invariant; public gateway requests are normalized before reaching it.

Upstream first-content and idle timers run before collection. The response is not
committed until collection completes, so stream errors or truncation cannot turn
a partial answer into successful JSON. The overall request deadline still applies.

## Supported boundary

- System/developer instructions, text, user images (URL/base64), function definitions,
  named/auto/required tool choice, tool call IDs and JSON arguments, text tool results.
- Parallel function calls and subsequent tool-result turns. Responses function call
  items are merged into a Chat assistant turn before emitting tool results.
- Responses custom tools (including Codex's freeform `apply_patch`) are offered to
  other upstream protocols as a function with one string `input` parameter. Replies
  restore `custom_tool_call` items and input delta/done events. Namespaced tools use
  collision-checked aliases upstream and regain their original name and namespace
  on return; tool results retain their call IDs across turns.
- Client-executed Responses tool search is offered as a normal function and
  returned as a `tool_search_call` with object arguments and `execution: client`.
  `tool_search_output` loads function/custom schemas from complete input history,
  including namespaces, without requiring the client to repeat them in `tools`.
  Deferred schemas stay hidden until loaded. Developer `additional_tools` items
  load schemas while retaining a marker at their position in history.
- Non-streaming JSON; incremental SSE with fragmented UTF-8 and CRLF; stream-to-JSON
  collection if an upstream streams despite a non-streaming request; JSON-to-SSE.
- Reasoning text/summary, token usage including cache hits, max-token completion,
  backpressure, cancellation and bounded decompression/response buffering.
- Stream start/item/delta/done/terminal events for Responses and Messages, and Chat
  chunks plus `[DONE]`. Terminal success is not synthesized after truncated SSE.

Client-facing models use the requested gateway model ID; upstream requests use the
provider's native ID. Existing retry/admission controls remain authoritative. A
conversion failure before commitment can fail over; after commitment it cannot.
Tool argument/name fragments are assembled before publishing a tool block's start.

## Explicit limitations

Conversion cannot supply capabilities the upstream model does not have. There is no
per-model capability database yet: upstreams can still reject unsupported vision,
function calling or sampling settings.

Cross-protocol requests are stateless. Responses `previous_response_id`, conversation,
background mode and explicit `store: true` are rejected with a 400; callers must send
full history. No GET/DELETE response store is provided. `include` cannot manufacture
opaque reasoning tokens: standalone encrypted history cannot be translated. Native
signed/encrypted state associated with tool calls is kept in the bounded account-bound
store described below. Web search uses the provider-independent hosted-tool runtime described below. Other vendor built-in tools (computer use, code interpreter, image generation), hosted
server-executed tool search, documents/audio, nontext tool results and unsupported content blocks fail
explicitly. Same-protocol requests can still use their native features.

A custom tool's grammar is supplied to the upstream model as instructions; foreign
providers cannot enforce a native Responses grammar. The gateway requires exactly
one string input and preserves its bytes, while the client remains responsible for
validating/executing its own tool. Custom input is buffered within the existing
response limit until complete to avoid corrupting escaped characters across frames.

Reasoning summaries are not cryptographic thinking signatures. Signed/opaque state
is never invented; unsigned historical reasoning is not replayed as Anthropic signed
thinking. An effort hint targeting Messages is rejected rather than guessing a
vendor-specific thinking budget. Cache-control hints and vendor-specific metadata
are not replayed across protocols. Chat stop sequences cannot be represented in a
Responses request; structured-output settings targeting Messages are not yet mapped.

Automatic group IDs retain their existing protocol namespace for configuration
compatibility, but those groups can be called through any of the three client APIs.
Manual fallback groups may contain mixed upstream protocols. Session affinity is
keyed by the client protocol, not the selected upstream protocol.

Tests use independent wire fixtures and local HTTP servers, never user credentials.
They do not establish compatibility with every version of a real agent or vendor.

## Implementation design

See [Agent 网关转发与协议兼容设计](../../../../../docs/agent-gateway-forwarding.md) for the current client/protocol matrix, Gemini native API gaps, opaque-state handling, implementation stages, and acceptance cases.


## Native state and Gemini

`gemini.ts` implements native request/response mapping; `gemini-route.ts` parses
encoded model paths and builds upstream URLs from configured providers only.
`native-state.ts` binds tool history to the authenticated account, provider,
native model and optional session. Short call IDs reference a 30-minute,
1024-entry, 16 MiB in-memory cache. Expired or altered history fails explicitly.
No signature is fabricated, and opaque history is never discarded for a retry.

## Native Responses

Responses SSE aggregation uses complete native response/item snapshots instead of
the normalized event encoder. Native IDs, encrypted reasoning, custom tool input,
hosted tools and unknown extension items survive. Legacy terminal events without an
output array can be reconstructed from snapshots and supported deltas; missing
unknown items, inconsistent empty completed output, errors and truncation fail.
JSON-only Responses upstreams can also feed streaming clients with native item,
content, delta/done and terminal events, preserving opaque fields in full snapshots.

Third-party Responses upstreams receive client-owned search as an ordinary function,
and its calls/results are mapped back without translating unrelated native items,
storage controls or opaque history through Chat. Loaded namespace tools merge and
lose only their defer flags. The Codex subscription retains its native search API.
Managed state references still pass origin validation before such a request is sent.

Gateway SSE inspection validates the source and client protocol's terminal marker,
including compressed upstreams, so a native stream ending after content without a
terminal event is a failure. A committed failure never triggers a replay. Prefix
and frame budgets are separate; complete post-content frames up to 1 MiB are allowed.

Only same-protocol feature headers in `features.ts` pass upstream. Count endpoints
forward to native API-key/OAuth providers; cross-protocol or subscription counting
returns 422 rather than an invented token count. Deferred schemas without a client
search or loaded history, unsupported hosted built-in tools, and
asynchronous tools are explicit conversion errors. Responses storage, compaction and
WebSocket sessions remain separate future work.

## Hosted web search across protocols

`hosted-tools.ts` lowers Responses `web_search` / `web_search_preview`, Messages
versioned web-search declarations, Chat `web_search_options`, and Gemini
`googleSearch` to one gateway-owned function. This is independent of subscription
identity: WorkBuddy, Qoder, API keys and future upstreams use the same loop.
Same-protocol native traffic remains untouched.

The model requests a search; the gateway executes it, sends the real sources and
findings back as a tool result, and continues the model. Client-owned function,
namespace and custom tools are still returned to the client. Codex's freeform
`apply_patch` is never executed on the gateway. Search history is lowered to text
when replayed to a foreign protocol, even after search is no longer offered.

`web-search.ts` tries at most three enabled, authenticated Responses providers
using only the query and search constraints, not the conversation. It requires a
completed native search item and valid HTTP(S) source URLs before reporting
success. An internal executor can also be supplied through `AgentGateway.webSearch`.
A missing backend, refused search or exhausted budget becomes a tool result the
model can explain, with no fabricated source and no successful search marker.
The original coding request no longer fails just because Codex advertises search.
This does not add search capability to a model that has no search backend.

The runtime limits searches to six per request (also respecting `max_uses`),
disables the function after a failed search, preserves cancellation, bounds each
native search backend to 30 seconds, and collects model rounds before publishing
the final JSON/SSE. Ordinary requests retain their existing incremental streaming;
search-runtime responses currently publish after the bounded tool loop finishes.
Responses gets web-search items and URL citations; Messages gets server-tool
blocks; Gemini gets grounding source metadata. Vendor encryption is not invented.
Native hosted features outside web search still require a native upstream or an
explicit execution capability; they are not silently dropped.


## Client-side Messages tool discovery

`messages-tools.ts` lowers client-owned discovery into portable function tools.
Initial cross-protocol requests contain ordinary tools and `ToolSearch` (or
`MCPSearch`), but no dormant schemas or `DeferredToolPlaceholder`. Tool results
containing `tool_reference` load only the referenced definitions into subsequent
requests, preserving mixed text, parallel call IDs, error results and duplicate
references. Already invoked tools remain callable when discovery is absent from
later history. Missing or ambiguous definitions fail explicitly; the converter
never invents schemas or falls back to loading every tool.

Discovery is executed by the client, not by a new gateway-side MCP service.
Messages→Chat/Responses/Gemini share the same normalization. Native Messages stays
native, including discovery metadata when opaque state is restored. Streaming and
JSON responses use the ordinary tool-call encoders and existing native-state cache.
The gateway does not truncate user context or change model context limits.
