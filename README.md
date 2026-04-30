
  ██╗  ██╗██╗██████╗  █████╗ ██╗   ██╗██████╗ ███████╗
  ██║ ██╔╝██║██╔══██╗██╔══██╗██║   ██║██╔══██╗██╔════╝
  █████╔╝ ██║██████╔╝███████║██║   ██║██║  ██║█████╗
  ██╔═██╗ ██║██╔══██╗██╔══██║██║   ██║██║  ██║██╔══╝
  ██║  ██╗██║██║  ██║██║  ██║╚██████╔╝██████╔╝███████╗
  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
                                                  v0.1.0


Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) powered by [Kiro CLI](https://kiro.dev). One command, zero config.

```bash
npx kiraude
```

This starts an Anthropic API-compatible proxy backed by Kiro CLI, then launches Claude Code pointed at it. Claude Code thinks it's talking to the Anthropic API; Kiro does the work.

## How it works

```
┌──────────────────────────┐
│  Claude Code             │
└────────────┬─────────────┘
             │ Anthropic Messages API
             ▼
┌──────────────────────────┐
│  kiraude proxy           │
│  (Express.js)            │
└────────────┬─────────────┘
             │ ACP (Agent Client Protocol)
             ▼
┌──────────────────────────┐
│  kiro-cli acp workers    │
└──────────────────────────┘
```

The proxy translates Anthropic API requests into ACP calls to `kiro-cli acp` subprocesses, then translates responses back into the Anthropic format with full streaming SSE support.

### Architecture

```
src/
├── index.ts                        # Express server, CORS, health check, lifecycle
├── acp-worker.ts                   # Single kiro-cli subprocess + ACP connection
├── pool.ts                         # Worker pool (acquire/release, dead worker replacement)
├── session-manager.ts              # Session affinity via x-claude-code-session-id
├── translator.ts                   # Anthropic ↔ ACP format translation
├── kiro-models.ts                  # Model alias resolution (claude-sonnet-4-6 → claude-sonnet-4.6)
├── sse.ts                          # SSE event helpers (message_start, content_block_delta, etc.)
├── banner.ts                       # ASCII banner on startup
├── persona.ts                      # Builds persona/instructions prefix for new ACP sessions
├── prompt-cache.ts                 # PromptCacheRegistry — prefix hash → ACP session ID
├── tool-renderer.ts                # Renders ACP tool_call/plan updates into markdown for SSE
├── tool-synth.ts                   # Synthesizes Anthropic tool_use blocks from ACP tool_call updates
├── recap.ts                        # Builds TodoWrite plan entries from ACP plan updates
├── mcp-config.ts                   # Loads MCP server config for kiro ACP sessions
├── utils.ts                        # Shared utilities (unreachable, etc.)
├── logger.ts                       # Pino logger setup
├── bin/kiraude.ts                  # CLI: starts proxy, launches claude
├── middleware/
│   ├── request-logger.ts           # Request/response body logging
│   └── rate-limit-headers.ts       # Injects Anthropic rate-limit headers (no cooldowns)
└── routes/
    ├── messages.ts                 # POST /v1/messages (streaming + non-streaming)
    ├── models.ts                   # GET /v1/models, token counting
    └── bootstrap.ts                # GET /api/claude_cli/bootstrap (model picker)
```

## Prerequisites

- **Node.js 18+**
- **kiro-cli** installed and on `$PATH` (or set `KIRO_CLI_PATH`)
- **claude** (Claude Code) installed and on `$PATH`

## Quick start

```bash
# Run directly (no install needed)
npx kiraude

# Or install globally
npm install -g kiraude
kiraude

# Pass args through to Claude Code
npx kiraude --print "explain this codebase"
```

## Use as a standalone proxy

Start the server and point any Anthropic SDK client at it:

```bash
git clone https://github.com/sabeur/kiraude.git
cd kiraude
npm install
npm run dev
```

```bash
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dummy claude
```

```python
import anthropic

client = anthropic.Anthropic(
    api_key="dummy",
    base_url="http://localhost:3456",
)

message = client.messages.create(
    model="kiro",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

The API key value is ignored; the server does not validate it.

## Configuration

| Environment variable | Default    | Description                           |
|----------------------|------------|---------------------------------------|
| `PORT`               | `3456`     | HTTP server listen port               |
| `POOL_SIZE`          | `4`        | Number of concurrent kiro-cli workers |
| `MAX_SESSIONS_PER_WORKER` | `8`   | ACP sessions multiplexed per worker   |
| `HOT_SPARE`          | `true`     | Keep one extra pre-warmed worker      |
| `KIRO_CLI_PATH`      | `kiro-cli` | Path to kiro-cli binary               |
| `TRUST_ALL_TOOLS`    | `true`     | Pass `--trust-all-tools` to kiro-cli. Set to `false` to disable. |
| `TRUST_TOOLS`        |            | Comma-separated tool names for `--trust-tools`. Overrides `TRUST_ALL_TOOLS`. |
| `EMULATE_CC_TOOLS`   | `true`     | Synthesize `kiro_*` tool_use blocks so Claude Code renders diffs/edits. Set to `false` for plain text only. |
| `KIRO_MCP_SERVERS_JSON` |         | Inline JSON array of MCP server configs forwarded to kiro on session start. |
| `KIRO_MCP_SERVERS_FILE` |         | Path to JSON file with MCP server configs (alternative to `KIRO_MCP_SERVERS_JSON`). |
| `LOG_LEVEL`          | `info`     | Pino log level (`debug`, `info`, `warn`, `error`) |
| `RESPONSE_LOG_LEVEL` | `silent`   | Log level for response body logging |
| `HTTP_LOG_LEVEL`     | `silent`   | Log level for HTTP request/response logging |
| `LOG_REQUEST_BODIES` |            | Set `true` to log full request/response bodies to file |

### Permission handling

By default, the proxy passes `--trust-all-tools` to each `kiro-cli acp` subprocess so the agent auto-approves all tool permission requests. This is the recommended setting for local development.

For granular control:

```bash
TRUST_TOOLS="fs_read,fs_write,execute_bash" npx kiraude
```

When `TRUST_TOOLS` is set, only those tools are trusted; `TRUST_ALL_TOOLS` is ignored.

## Model aliases

Claude Code sends model names like `claude-sonnet-4-6`. The proxy resolves these to Kiro model IDs automatically.

| Claude Code sends | Kiro receives |
|-------------------|---------------|
| `sonnet` | `claude-sonnet-4.6` |
| `opus` | `claude-opus-4.6` |
| `haiku` | `claude-haiku-4.5` |
| `claude-sonnet-4-6` | `claude-sonnet-4.6` |
| `claude-opus-4-6` | `claude-opus-4.6` |
| `kiro` | `auto` |
| `kiro-sonnet` | `claude-sonnet-4.6` |
| Any dot-notation ID | Passed through as-is |

The full alias map is in `src/kiro-models.ts`.

## API endpoints

| Method | Path                        | Description                       |
|--------|-----------------------------|-----------------------------------|
| `GET`  | `/health`                   | Health check (pool status, session count) |
| `GET`  | `/v1/models`                | List available models             |
| `GET`  | `/v1/models/:modelId`       | Get a specific model              |
| `POST` | `/v1/messages`              | Create message (streaming or not) |
| `POST` | `/v1/messages/count_tokens` | Estimate token count              |

## Supported features

| Feature | Status |
|---------|--------|
| Streaming (SSE) | ✅ |
| Non-streaming | ✅ |
| System prompts | ✅ |
| Multi-turn conversations | ✅ |
| Tool use | ✅ |
| Extended thinking | ✅ |
| Image content (base64) | ✅ |
| Token counting | ✅ (heuristic) |
| Session affinity | ✅ |
| Client disconnect handling | ✅ |
| Keepalive pings | ✅ |
| Dead worker auto-replacement | ✅ |
| MCP server forwarding | ✅ |

## Troubleshooting

### "claude" not found on PATH

Install Claude Code: `npm install -g @anthropic-ai/claude-code`

### "kiro-cli" not found

Install Kiro CLI from [kiro.dev](https://kiro.dev), or set the path:

```bash
KIRO_CLI_PATH=/path/to/kiro-cli npx kiraude
```

### Port already in use

```bash
PORT=4000 npx kiraude
```

### Workers timing out

Increase the pool size for concurrent requests:

```bash
POOL_SIZE=8 npx kiraude
```

### Verbose logging

```bash
LOG_LEVEL=debug npm run dev
```

## Running in the background

Run the proxy without tying up a terminal.

### Using nohup

```bash
nohup npm start > /dev/null 2>&1 &
echo $!  # prints the PID
```

Kill it later:

```bash
kill $(lsof -ti:3456)
```

### Using a PID file

```bash
npm start &
echo $! > .kiraude.pid

# Stop it
kill $(cat .kiraude.pid) && rm .kiraude.pid
```

### Using pm2

```bash
npm install -g pm2
pm2 start dist/index.js --name kiraude
pm2 stop kiraude    # pause
pm2 restart kiraude # restart
pm2 delete kiraude  # remove
pm2 logs kiraude    # tail logs
```

### Quick health check

```bash
curl -s http://localhost:3456/health | jq .
```

## Security

This proxy is designed for **local development only**.

- No API key validation. Any request is accepted.
- CORS is wide open (`Access-Control-Allow-Origin: *`).
- All tool permission requests are auto-approved by default.
- File system operations (read/write) have no path restrictions.
- Terminal commands have no restrictions.

Do not expose this server to the internet or untrusted networks.

## Development

```bash
npm run dev        # start with hot reload
npm run build      # compile TypeScript
npm start          # run compiled output
npm test           # run tests (130 tests across 9 files)
npm run test:watch # watch mode
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

MIT

Copyright © 2026 Sabeur Thabti
