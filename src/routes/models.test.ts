import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import createModelsRouter from './models.js'

const createTestApp = (): express.Express => {
  const app = express()
  app.use(express.json())
  app.use(createModelsRouter())
  return app
}

const makeRequest = async (
  app: express.Express,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> => {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const url = `http://127.0.0.1:${port}${path}`
      const options: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
      if (body) options.body = JSON.stringify(body)
      fetch(url, options)
        .then(async (res) => {
          const json = await res.json()
          server.close()
          resolve({ status: res.status, body: json })
        })
        .catch((err) => {
          server.close()
          throw err
        })
    })
  })
}

describe('GET /v1/models', () => {
  it('returns model list', async () => {
    const app = createTestApp()
    const actual = await makeRequest(app, 'GET', '/v1/models')
    expect(actual.status).toBe(200)
    const data = actual.body as { object: string; data: Array<{ id: string }> }
    expect(data.object).toBe('list')
    expect(data.data.length).toBeGreaterThan(1)
    expect(data.data.some((m) => m.id === 'kiro')).toBe(true)
    expect(data.data.some((m) => m.id === 'claude-sonnet-4-6')).toBe(true)
  })
})

describe('POST /v1/messages/count_tokens', () => {
  it('counts tokens from string messages', async () => {
    const app = createTestApp()
    const actual = await makeRequest(app, 'POST', '/v1/messages/count_tokens', {
      messages: [{ role: 'user', content: '12345678' }],
    })
    expect(actual.status).toBe(200)
    expect((actual.body as { input_tokens: number }).input_tokens).toBe(2)
  })

  it('counts tokens from content block arrays', async () => {
    const app = createTestApp()
    const actual = await makeRequest(app, 'POST', '/v1/messages/count_tokens', {
      messages: [{ role: 'user', content: [{ type: 'text', text: '12345678' }] }],
    })
    expect(actual.status).toBe(200)
    expect((actual.body as { input_tokens: number }).input_tokens).toBe(2)
  })

  it('includes system text in token count', async () => {
    const app = createTestApp()
    const actual = await makeRequest(app, 'POST', '/v1/messages/count_tokens', {
      messages: [{ role: 'user', content: '1234' }],
      system: '5678',
    })
    expect(actual.status).toBe(200)
    expect((actual.body as { input_tokens: number }).input_tokens).toBe(2) // 8 chars / 4
  })

  it('returns 400 when messages is missing', async () => {
    const app = createTestApp()
    const actual = await makeRequest(app, 'POST', '/v1/messages/count_tokens', {})
    expect(actual.status).toBe(400)
  })
})
