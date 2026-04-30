import type { Request, Response, NextFunction } from 'express'
import logger from '../logger.js'

const MAX_BODY_LOG_LENGTH = 2048

const truncateBody = (body: unknown): unknown => {
  if (!body) return undefined
  const serialized = JSON.stringify(body)
  if (serialized.length <= MAX_BODY_LOG_LENGTH) return body
  return `${serialized.slice(0, MAX_BODY_LOG_LENGTH)}... [truncated ${serialized.length} chars]`
}

const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now()
  const requestId = req.headers['x-client-request-id'] ?? crypto.randomUUID()

  logger.info({
    type: 'request',
    requestId,
    method: req.method,
    path: req.originalUrl,
    headers: {
      'content-type': req.headers['content-type'],
      'x-claude-code-session-id': req.headers['x-claude-code-session-id'],
      'anthropic-version': req.headers['anthropic-version'],
    },
    body: truncateBody(req.body),
  }, `→ ${req.method} ${req.originalUrl}`)

  const originalJson = res.json.bind(res)
  res.json = (body: unknown): Response => {
    const durationMs = Date.now() - startTime
    logger.info({
      type: 'response',
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      body: truncateBody(body),
    }, `← ${res.statusCode} ${req.method} ${req.originalUrl} (${durationMs}ms)`)
    return originalJson(body)
  }

  const originalEnd = res.end.bind(res)
  res.end = ((...args: Parameters<Response['end']>): Response => {
    const durationMs = Date.now() - startTime
    if (res.getHeader('content-type')?.toString().includes('text/event-stream')) {
      logger.info({
        type: 'response',
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
        streaming: true,
      }, `← ${res.statusCode} ${req.method} ${req.originalUrl} SSE stream ended (${durationMs}ms)`)
    }
    return originalEnd(...args) as Response
  }) as Response['end']

  next()
}

export default requestLogger
