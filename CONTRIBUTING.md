# Contributing to kiraude

Thanks for your interest in contributing. This guide covers the basics.

## Development setup

```bash
git clone https://github.com/thabti/kiraude.git
cd kiraude
npm install
npm run dev    # starts the proxy with hot reload
npm test       # runs the test suite
```

Requires Node.js 18+ and kiro-cli on your PATH.

## Project structure

```
src/
├── index.ts              # Express server entry point, lifecycle
├── acp-worker.ts         # Single kiro-cli ACP subprocess + connection
├── pool.ts               # Worker pool with session affinity
├── session-manager.ts    # Session lifecycle and cleanup
├── translator.ts         # Anthropic ↔ ACP format translation
├── kiro-models.ts        # Model alias resolution
├── sse.ts                # SSE event writing helpers
├── logger.ts             # Pino logger config
├── banner.ts             # ASCII banner on startup
├── persona.ts            # Builds persona/instructions prefix for new ACP sessions
├── prompt-cache.ts       # PromptCacheRegistry — prefix hash → ACP session ID
├── tool-renderer.ts      # Renders ACP tool_call/plan updates into markdown for SSE
├── tool-synth.ts         # Synthesizes Anthropic tool_use blocks from ACP tool_call updates
├── recap.ts              # Builds TodoWrite plan entries from ACP plan updates
├── mcp-config.ts         # Loads MCP server config for kiro ACP sessions
├── utils.ts              # Shared utilities (unreachable, etc.)
├── bin/
│   └── kiraude.ts        # CLI entry point (npx kiraude)
├── middleware/
│   ├── request-logger.ts       # Request/response body logging
│   └── rate-limit-headers.ts   # Injects Anthropic rate-limit headers
└── routes/
    ├── messages.ts       # POST /v1/messages (streaming + non-streaming)
    ├── models.ts         # GET /v1/models, POST /v1/messages/count_tokens
    └── bootstrap.ts      # GET /api/claude_cli/bootstrap
```

## Running tests

```bash
npm test           # run once
npm run test:watch # watch mode
npm run build      # verify TypeScript compiles
```

Tests use [Vitest](https://vitest.dev). Each source file has a corresponding `.test.ts` file. Follow the existing patterns:

- Use `describe` / `it` blocks
- Follow Arrange-Act-Assert
- Prefix test variables: `input*`, `mock*`, `actual*`, `expected*`
- Mock external dependencies (ACP SDK, child processes) — don't spawn real subprocesses

## Making changes

1. Branch from `main`
2. Make changes
3. Run `npm test` and `npm run build`
4. Submit a pull request

### Code style

- TypeScript strict mode, no `any`
- ESM imports with `.js` extensions
- camelCase for variables/functions, PascalCase for classes/types
- kebab-case for file names
- One export per file where practical
- No comments unless the WHY is non-obvious

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add model alias for claude-4
fix: handle empty tool_result content
test: add pool timeout coverage
docs: update README configuration table
```

## Common contribution areas

### Adding model aliases

Aliases live in `src/kiro-models.ts` in `ALIAS_MAP`. Map the Claude Code model name to the Kiro model ID:

```typescript
const ALIAS_MAP: Record<string, string> = {
  'new-alias': 'kiro-model-id',
}
```

### Adding tool synthesis

`src/tool-synth.ts` maps ACP `tool_call` names to Anthropic `tool_use` blocks. Add a new case in `synthesizeToolUse()` following the existing pattern.

### Adding MCP server support

MCP config loading is in `src/mcp-config.ts`. Config is forwarded to kiro on `newSession` via `KIRO_MCP_SERVERS_JSON` or `KIRO_MCP_SERVERS_FILE`.

## Reporting issues

Open an issue on GitHub with:

- What you expected
- What happened
- Steps to reproduce
- Node.js version and OS

## License

By contributing, you agree your contributions will be licensed under the MIT License.
