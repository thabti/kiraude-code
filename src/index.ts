import express from 'express'
import type { Request, Response, NextFunction } from 'express'
import type { Server } from 'node:http'
import { pinoHttp } from 'pino-http'
import logger, { httpLogger } from './logger.js'
import AcpPool from './pool.js'
import SessionManager from './session-manager.js'
import createMessagesRouter from './routes/messages.js'
import createModelsRouter from './routes/models.js'
import createBootstrapRouter from './routes/bootstrap.js'
import rateLimitHeaders from './middleware/rate-limit-headers.js'
import requestLogger from './middleware/request-logger.js'
import { printBanner } from './banner.js'

const PORT = parseInt(process.env['PORT'] ?? '3456', 10)
const POOL_SIZE = parseInt(process.env['POOL_SIZE'] ?? '4', 10)
const MAX_SESSIONS_PER_WORKER = parseInt(process.env['MAX_SESSIONS_PER_WORKER'] ?? '8', 10)
const HOT_SPARE = process.env['HOT_SPARE'] !== 'false'
const KIRO_CLI_PATH = process.env['KIRO_CLI_PATH'] ?? 'kiro-cli'

const app = express()

app.use(pinoHttp({ logger: httpLogger }))

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
      inFlight: pool.getInFlightCount(),
      queued: pool.getQueueLength(),
    },
    sessions: sessionManager.getSessionCount(),
  })
})

const pool = new AcpPool({
  size: POOL_SIZE,
  cwd: process.cwd(),
  kiroCli: KIRO_CLI_PATH,
  maxConcurrentSessionsPerWorker: MAX_SESSIONS_PER_WORKER,
  hotSpare: HOT_SPARE,
})
const sessionManager = new SessionManager({ pool })

app.use(rateLimitHeaders)

const messagesRouter = createMessagesRouter({ pool, sessionManager })
app.use(messagesRouter)

const modelsRouter = createModelsRouter()
app.use(modelsRouter)

const bootstrapRouter = createBootstrapRouter()
app.use(bootstrapRouter)

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

printBanner(PORT, POOL_SIZE)

pool.init().then(() => {
  sessionManager.startCleanup()
  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'http server listening')
  })
}).catch((err) => {
  logger.fatal({ err }, 'failed to initialize pool')
  process.exit(1)
})

process.on('SIGTERM', () => { shutdown('SIGTERM') })
process.on('SIGINT', () => { shutdown('SIGINT') })

export default app
