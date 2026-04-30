#!/usr/bin/env node
import { execSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { pinoHttp } from 'pino-http'
import logger, { httpLogger } from '../logger.js'
import AcpPool from '../pool.js'
import SessionManager from '../session-manager.js'
import createMessagesRouter from '../routes/messages.js'
import createModelsRouter from '../routes/models.js'
import { printBanner } from '../banner.js'
import createBootstrapRouter from '../routes/bootstrap.js'
import rateLimitHeaders from '../middleware/rate-limit-headers.js'

const portArgIdx = ['--port', '-p'].reduce((idx, flag) => idx !== -1 ? idx : process.argv.indexOf(flag), -1)
const portArg = portArgIdx !== -1 ? process.argv[portArgIdx + 1] : undefined
const PORT = parseInt(portArg ?? process.env['PORT'] ?? '3456', 10)
if (portArgIdx !== -1) process.argv.splice(portArgIdx, 2)
const POOL_SIZE = parseInt(process.env['POOL_SIZE'] ?? '2', 10)
const KIRO_CLI_PATH = process.env['KIRO_CLI_PATH'] ?? 'kiro-cli'

const findClaude = (): string | null => {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

const startServer = async (): Promise<void> => {
  const app = express()
  app.use(pinoHttp({ logger: httpLogger, autoLogging: false }))
  app.use((_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, ' +
      'x-app, x-client-request-id, x-claude-code-session-id, User-Agent',
    )
    next()
  })
  app.options('*', (_req: Request, res: Response): void => { res.sendStatus(204) })
  app.use(express.json({ limit: '10mb' }))

  const pool = new AcpPool({ size: POOL_SIZE, cwd: process.cwd(), kiroCli: KIRO_CLI_PATH })
  const sessionManager = new SessionManager({ pool })

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.use(rateLimitHeaders)
  app.use(createMessagesRouter({ pool, sessionManager }))
  app.use(createModelsRouter())
  app.use(createBootstrapRouter())

  await pool.init()
  sessionManager.startCleanup()

  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(PORT, () => {
      resolve()
    })

    const shutdown = async (): Promise<void> => {
      server.close()
      await sessionManager.shutdown()
      await pool.shutdown()
    }

    process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)) })
    process.on('SIGINT', () => { shutdown().then(() => process.exit(0)) })
  })
}

const main = async (): Promise<void> => {
  const claudePath = findClaude()
  if (!claudePath) {
    console.error('Error: "claude" not found on PATH.')
    console.error('Install Claude Code: https://docs.anthropic.com/en/docs/claude-code')
    process.exit(1)
  }

  console.log(`Starting kiraude proxy on port ${PORT}...`)
  await startServer()
  printBanner(PORT, POOL_SIZE)

  const child = spawn(claudePath, process.argv.slice(2), {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
      ANTHROPIC_API_KEY: 'sk-ant-dummy',
      // Disable experimental betas that may cause issues with proxy
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      // Disable fast mode entirely (prevents cooldown/degradation cycles)
      CLAUDE_CODE_DISABLE_FAST_MODE: '1',
      // Max effort by default
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      // Disable telemetry to avoid calls to Anthropic endpoints
      CLAUDE_CODE_DISABLE_TELEMETRY: '1',
    },
  })

  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
