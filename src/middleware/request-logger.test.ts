import { describe, it, expect } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import requestLogger from './request-logger.js'

const makeRequest = async (
  app: express.Express,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body?: unknown; text?: string }> => {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const options: RequestInit = { method, headers: {} }
      if (body) {
        options.headers = { 'Content-Type': 'application/json' }
        options.body = JSON.stringify(body)
      }
      fetch(`http://127.0.0.1:${port}${path}`, options)
        .then(async (res) => {
          const contentType = res.headers.get('content-type') ?? ''
          const result: { status: number; body?: unknown; text?: string } = { status: res.status }
          if (contentType.includes('json')) {
            result.body = await res.json()
          } else {
            result.text = await res.text()
          }
          server.close()
          resolve(result)
        })
    })
  })
}

describe('requestLogger middleware', () => {
  it('passes requests through to the next handler', async () => {
    const app = express()
    app.use(express.json())
    app.use(requestLogger)
    app.post('/test', (req, res) => { res.json({ echo: req.body }) })

    const actual = await makeRequest(app, 'POST', '/test', { message: 'hello' })
    expect(actual.status).toBe(200)
    expect((actual.body as { echo: { message: string } }).echo.message).toBe('hello')
  })

  it('handles requests without body', async () => {
    const app = express()
    app.use(requestLogger)
    app.get('/health', (_req, res) => { res.json({ status: 'ok' }) })

    const actual = await makeRequest(app, 'GET', '/health')
    expect(actual.status).toBe(200)
    expect((actual.body as { status: string }).status).toBe('ok')
  })

  it('handles large request bodies without crashing', async () => {
    const app = express()
    app.use(express.json({ limit: '10mb' }))
    app.use(requestLogger)
    app.post('/test', (_req, res) => { res.json({ ok: true }) })

    const largeBody = { data: 'x'.repeat(5000) }
    const actual = await makeRequest(app, 'POST', '/test', largeBody)
    expect(actual.status).toBe(200)
  })

  it('handles SSE streaming responses', async () => {
    const app = express()
    app.use(requestLogger)
    app.get('/sse', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.write('data: test\n\n')
      res.end()
    })

    const actual = await makeRequest(app, 'GET', '/sse')
    expect(actual.status).toBe(200)
    expect(actual.text).toContain('data: test')
  })

  it('preserves response status codes', async () => {
    const app = express()
    app.use(express.json())
    app.use(requestLogger)
    app.post('/error', (_req, res) => { res.status(400).json({ error: 'bad request' }) })

    const actual = await makeRequest(app, 'POST', '/error', { bad: true })
    expect(actual.status).toBe(400)
  })
})
