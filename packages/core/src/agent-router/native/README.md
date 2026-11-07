# Native Claude and Codex channels

- Codex uses ChatGPT OAuth with PKCE and a state-checked loopback callback on
  port 1455. Its encrypted credential belongs to this gateway; the user's
  `~/.codex/auth.json` is never modified. Models and quota come from the account's
  live catalog. Native requests use Responses; the gateway handles other client
  protocols. Non-streaming requests collect Codex's completion event.
- Claude invokes the installed native Claude Code CLI. It accepts either the
  CLI's existing Claude.ai login or a setup-token kept in the encrypted vault.
  A local account reference is checked for identity changes before inference.
  It does not copy the CLI's refresh token. Extra model names come from the CLI's
  account cache, with Sonnet/Opus/Haiku aliases as baseline; token accounts do not
  inherit another account's gated model cache. Quota uses the CLI's `/usage`.
- Claude starts a fresh print-mode turn with a replayed transcript. It does not
  preserve Claude Code session IDs or claim byte-identical prompt replay. Its
  built-in tools, project settings, and external MCP configuration are disabled.
  A request-local loopback MCP server advertises only the caller's tools; no
  client tool is executed in the gateway. Claude's first message, including tool
  calls, is returned to the caller. CLI messages are streamed as Messages events.
- Claude requires the native `claude` executable (or `CLAUDE_CLI_PATH`). No CLI is
  downloaded automatically. Cancelled requests stop their child process; worker
  disposal also terminates tracked children. Neither channel logs credentials.

Tests use mocked OAuth/model endpoints and a fake Claude executable. Real account
permissions, provider policy changes, and installed CLI-version differences need
an explicit end-to-end login check; tests do not spend a user's subscription quota.
