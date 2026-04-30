# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-30

### Added

- Anthropic Messages API proxy backed by kiro-cli ACP workers
- Full streaming SSE support matching the Anthropic event format
- Non-streaming JSON responses
- Worker pool with configurable size and acquire timeout
- Session affinity via `x-claude-code-session-id` header
- Automatic session cleanup for idle sessions (30 min default)
- Model alias resolution: Claude Code model names map to Kiro model IDs
- Extended thinking support (thinking_delta, signature_delta)
- Image content passthrough (base64)
- Tool use translation between Anthropic and ACP formats
- Token counting endpoint (heuristic, 4 chars per token)
- `--trust-all-tools` flag passed to kiro-cli by default
- `TRUST_TOOLS` env var for granular tool permission control
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` set automatically in kiraude CLI
- Client disconnect detection with prompt cancellation
- Keepalive ping every 15 seconds during streaming
- Dead worker auto-replacement
- Request/response logging with body truncation
- `npx kiraude` CLI that starts the proxy and launches Claude Code
- Health check endpoint at `GET /health`
- 130 unit tests across 9 test files
