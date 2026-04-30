import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import createMessagesRouter from './routes/messages.js'
import type AcpPool from './pool.js'
import type AcpWorker from './acp-worker.js'
import type { SessionUpdate, PromptResponse, ContentBlock } from '@agentclientprotocol/sdk'

const createMockWorker = (promptResult?: PromptResponse, onPromptCalled?: (content: ContentBlock[]) => void): AcpWorker => {
  return {
    id: 0,
    getState: () => 'busy',
    setState: vi.fn(),
    prompt: vi.fn(async (content: ContentBlock[], onUpdate?: (update: SessionUpdate) => void) => {
      onPromptCalled?.(content)
      if (onUpdate) {
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'test response' },
        } as SessionUpdate)
      }
      return promptResult ?? { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(),
  } as unknown as AcpWorker

}

const createMockPool = (worker?: AcpWorker): AcpPool => {
  const mockWorker = worker ?? createMockWorker()
  return {
    acquire: vi.fn(async () => mockWorker),
    release: vi.fn(),
  } as unknown as AcpPool
}

const createMockSessionManager = (pool: AcpPool) => ({
  acquireForSession: vi.fn(async () => {
    const worker = await (pool.acquire as ReturnType<typeof vi.fn>)()
    return { worker, isExistingSession: false }
  }),
  releaseWorker: vi.fn(),
})

const createTestApp = (pool: AcpPool): express.Express => {
  const app = express()
  app.use(express.json())
  const sessionManager = createMockSessionManager(pool) as any
  app.use(createMessagesRouter({ pool, sessionManager }))
  return app
}

const makeRequest = async (
  app: express.Express,
  body: unknown,
): Promise<{ status: number; body: unknown }> => {
  return new Promise((resolve) => {
    const server: Server = app.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
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

describe('POST /v1/messages validation', () => {
  it('rejects missing model', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const actual = await makeRequest(app, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 })
    expect(actual.status).toBe(400)
    expect((actual.body as { error: { message: string } }).error.message).toContain('model')
  })

  it('rejects missing messages', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const actual = await makeRequest(app, { model: 'kiro', max_tokens: 1024 })
    expect(actual.status).toBe(400)
    expect((actual.body as { error: { message: string } }).error.message).toContain('messages')
  })

  it('rejects missing max_tokens', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const actual = await makeRequest(app, { model: 'kiro', messages: [{ role: 'user', content: 'hi' }] })
    expect(actual.status).toBe(400)
    expect((actual.body as { error: { message: string } }).error.message).toContain('max_tokens')
  })

  it('rejects non-array messages', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const actual = await makeRequest(app, { model: 'kiro', messages: 'not-array', max_tokens: 1024 })
    expect(actual.status).toBe(400)
  })
})

describe('POST /v1/messages non-streaming', () => {
  it('returns a valid Anthropic response', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const actual = await makeRequest(app, {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
    })
    expect(actual.status).toBe(200)
    const data = actual.body as { type: string; role: string; content: Array<{ type: string; text: string }> }
    expect(data.type).toBe('message')
    expect(data.role).toBe('assistant')
    expect(data.content[0]!.type).toBe('text')
    expect(data.content[0]!.text).toBe('test response')
  })

  it('returns 529 when pool has no workers', async () => {
    const pool = {
      acquire: vi.fn(async () => { throw new Error('No workers') }),
      release: vi.fn(),
    } as unknown as AcpPool
    const app = createTestApp(pool)
    const actual = await makeRequest(app, {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
    })
    expect(actual.status).toBe(529)
  })
})

describe('POST /v1/messages streaming', () => {
  it('returns SSE events', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const responseText = await new Promise<string>((resolve) => {
      const server: Server = app.listen(0, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kiro',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 1024,
            stream: true,
          }),
        })
          .then(async (res) => {
            const text = await res.text()
            server.close()
            resolve(text)
          })
          .catch((err) => {
            server.close()
            throw err
          })
      })
    })
    expect(responseText).toContain('event: message_start')
    expect(responseText).toContain('event: message_stop')
  })
})

describe('POST /v1/messages non-streaming error handling', () => {
  it('returns 500 when worker prompt throws', async () => {
    const errorWorker = {
      id: 0,
      getState: () => 'busy',
      setState: vi.fn(),
      prompt: vi.fn(async () => { throw new Error('ACP connection lost') }),
      cancel: vi.fn(),
    } as unknown as AcpWorker
    const pool = createMockPool(errorWorker)
    const app = createTestApp(pool)
    const actual = await makeRequest(app, {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
    })
    expect(actual.status).toBe(500)
    expect((actual.body as { error: { type: string } }).error.type).toBe('api_error')
  })
})

describe('POST /v1/messages streaming details', () => {
  it('includes content_block_start and content_block_stop events', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const responseText = await new Promise<string>((resolve) => {
      const server: Server = app.listen(0, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kiro',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 1024,
            stream: true,
          }),
        })
          .then(async (res) => {
            const text = await res.text()
            server.close()
            resolve(text)
          })
      })
    })
    expect(responseText).toContain('event: content_block_start')
    expect(responseText).toContain('event: content_block_delta')
    expect(responseText).toContain('event: content_block_stop')
    expect(responseText).toContain('event: message_delta')
  })

  it('returns SSE headers', async () => {
    const pool = createMockPool()
    const app = createTestApp(pool)
    const headers = await new Promise<Record<string, string>>((resolve) => {
      const server: Server = app.listen(0, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kiro',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 1024,
            stream: true,
          }),
        })
          .then(async (res) => {
            await res.text()
            server.close()
            resolve(Object.fromEntries(res.headers.entries()))
          })
      })
    })
    expect(headers['content-type']).toBe('text/event-stream')
    expect(headers['cache-control']).toBe('no-cache')
  })
})
