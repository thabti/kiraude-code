import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { Server } from 'node:http'
import { pinoHttp } from 'pino-http'
import logger from './logger.js'
import AcpPool from './pool.js'
import SessionManager from './session-manager.js'
import createMessagesRouter from './routes/messages.js'
import createModelsRouter from './routes/models.js'
import requestLogger from './middleware/request-logger.js'

const PORT = parseInt(process.env['PORT'] ?? '3456', 10)
const POOL_SIZE = parseInt(process.env['POOL_SIZE'] ?? '5', 10)
const KIRO_CLI_PATH = process.env['KIRO_CLI_PATH'] ?? 'kiro-cli'

const app = express()

app.use(pinoHttp({ logger }))

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

app.options('*', (_req: Request, res: Response): void => {
  res.sendStatus(204)
})

app.use(express.json({ limit: '10mb' }))
app.use(requestLogger)

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    pool: {
      workers: pool.getWorkerCount(),
      idle: pool.getIdleCount(),
      queued: pool.getQueueLength(),
    },
    sessions: sessionManager.getSessionCount(),
  })
})

const pool = new AcpPool({ size: POOL_SIZE, cwd: process.cwd(), kiroCli: KIRO_CLI_PATH })
const sessionManager = new SessionManager({ pool })

const messagesRouter = createMessagesRouter({ pool, sessionManager })
app.use(messagesRouter)

const modelsRouter = createModelsRouter()
app.use(modelsRouter)

app.use((req: Request, res: Response): void => {
  logger.warn({ method: req.method, path: req.originalUrl }, 'route not found')
  res.status(404).json({
    type: 'error',
    error: { type: 'not_found_error', message: `${req.method} ${req.originalUrl} not found` },
  })
})

let server: Server

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down')
  server.close(() => {
    logger.info('http server closed')
  })
  await sessionManager.shutdown()
  await pool.shutdown()
  logger.info('shutdown complete')
  process.exit(0)
}

pool.init().then(() => {
  sessionManager.startCleanup()
  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'claude-kiro-server listening')
  })
}).catch((err) => {
  logger.fatal({ err }, 'failed to initialize pool')
  process.exit(1)
})

process.on('SIGTERM', () => { shutdown('SIGTERM') })
process.on('SIGINT', () => { shutdown('SIGINT') })

export default app
