#!/usr/bin/env node
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import { pinoHttp } from 'pino-http'
import { httpLogger } from '../logger.js'
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

  sessionManager.startCleanup()

  return new Promise((resolve, reject) => {
    const server = createServer(app)
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\nPort ${PORT} is already in use.\n`)
        console.error(`  Kill the existing process:  kill $(lsof -ti:${PORT})`)
        console.error(`  Or use a different port:    npx kiraude -p ${PORT + 1}\n`)
        process.exit(1)
      }
      reject(err)
    })
    server.listen(PORT, () => {
      printBanner(PORT, POOL_SIZE)
      pool.init().then(() => resolve()).catch((err) => {
        console.error('Pool init failed:', err)
        process.exit(1)
      })
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
  await startServer()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
