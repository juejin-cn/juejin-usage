# Gateway protocol conversion

The gateway keeps the client protocol separate from the provider's native protocol.
All six directions between Chat Completions, Responses and Anthropic Messages are
available. Same-protocol traffic remains byte-preserving unless a non-streaming
client receives upstream SSE, which is collected into JSON. No third-party runtime
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
opaque reasoning tokens: no encrypted reasoning is returned, and encrypted history
cannot be translated. Vendor built-in tools (web search, computer use, custom/freeform
tools), documents/audio, nontext tool results and unsupported content blocks fail
explicitly. Same-protocol requests can still use their native features.

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
