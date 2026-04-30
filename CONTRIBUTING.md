# Contributing to kiraude

Thanks for your interest in contributing. This guide covers the basics.

## Development setup

```bash
git clone https://github.com/sabeur/kiraude.git
cd kiraude
npm install
npm run dev    # starts the proxy with hot reload
npm test       # runs the test suite
```

Requires Node.js 18+ and kiro-cli on your PATH.

## Project structure

```
src/
├── index.ts                  # Express server entry point
├── acp-worker.ts             # Single kiro-cli ACP subprocess + connection
├── pool.ts                   # Worker pool manager
├── session-manager.ts        # Session affinity and lifecycle
├── translator.ts             # Anthropic ↔ ACP format translation
├── kiro-models.ts            # Model resolution and alias mapping
├── sse.ts                    # SSE event writing helpers
├── logger.ts                 # Pino logger config
├── bin/
│   └── kiraude.ts            # CLI entry point (npx kiraude)
├── middleware/
│   └── request-logger.ts     # Request/response logging
└── routes/
    ├── messages.ts            # POST /v1/messages
    └── models.ts              # GET /v1/models, token counting
```

## Running tests

```bash
npm test           # run once
npm run test:watch # watch mode
```

Tests use [Vitest](https://vitest.dev). Each source file has a corresponding `.test.ts` file. Follow the existing patterns:

- Use `describe` / `it` blocks
- Follow Arrange-Act-Assert
- Prefix test variables: `input*`, `mock*`, `actual*`, `expected*`
- Mock external dependencies (ACP SDK, child processes) rather than spawning real subprocesses

## Making changes

1. Create a branch from `main`
2. Make your changes
3. Run `npm test` and `npm run build` to verify
4. Submit a pull request

### Code style

- TypeScript strict mode
- ESM imports with `.js` extensions
- camelCase for variables/functions, PascalCase for classes/types
- kebab-case for file names
- One export per file where practical

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add model alias for claude-4
fix: handle empty tool_result content
test: add pool timeout coverage
docs: update README configuration table
```

## Reporting issues

Open an issue on GitHub with:

- What you expected to happen
- What happened instead
- Steps to reproduce
- Your Node.js version and OS

## Adding model aliases

Model aliases live in `src/kiro-models.ts` in the `ALIAS_MAP` constant. Add a new entry mapping the Claude Code model name to the Kiro model ID:

```typescript
const ALIAS_MAP: Record<string, string> = {
  'new-alias': 'kiro-model-id',
  // ...
}
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
