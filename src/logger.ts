import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'

const LOG_DIR = join(process.cwd(), 'logs')
const LOG_LEVEL = process.env['LOG_LEVEL'] ?? 'info'
const RESPONSE_LOG_LEVEL = process.env['RESPONSE_LOG_LEVEL'] ?? 'silent'
const HTTP_LOG_LEVEL = process.env['HTTP_LOG_LEVEL'] ?? 'silent'

const formatDate = (): string => {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Async destination — fire-and-forget writes with internal buffer. */
const asyncDest = (path: string): pino.DestinationStream =>
  pino.destination({ dest: path, sync: false, minLength: 4096 })

const createLogger = (): pino.Logger => {
  mkdirSync(LOG_DIR, { recursive: true })
  const date = formatDate()
  const streams: pino.StreamEntry[] = [
    { level: 'info', stream: process.stdout },
    { level: 'error', stream: process.stderr },
    { level: 'trace', stream: asyncDest(join(LOG_DIR, `app-${date}.log`)) },
    { level: 'error', stream: asyncDest(join(LOG_DIR, `error-${date}.log`)) },
  ]
  return pino({ level: LOG_LEVEL }, pino.multistream(streams))
}

const createResponseLogger = (): pino.Logger => {
  mkdirSync(LOG_DIR, { recursive: true })
  const date = formatDate()
  return pino(
    { level: RESPONSE_LOG_LEVEL },
    asyncDest(join(LOG_DIR, `claude-code-response-${date}.log`)),
  )
}

const createHttpLogger = (): pino.Logger => {
  mkdirSync(LOG_DIR, { recursive: true })
  return pino(
    { level: HTTP_LOG_LEVEL },
    asyncDest(join(LOG_DIR, 'http.log')),
  )
}

const logger = createLogger()

export const responseLogger = createResponseLogger()
export const httpLogger = createHttpLogger()

export default logger
