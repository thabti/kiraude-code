import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import SessionManager from './session-manager.js'
import type AcpPool from './pool.js'
import type AcpWorker from './acp-worker.js'

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const createMockWorker = (id = 0): AcpWorker => {
  const sessions: Map<string, string> = new Map()
  return {
    id,
    isReady: () => true,
    isDead: () => false,
    hasCapacity: () => true,
    getSessionCwd: vi.fn((sid: string) => {
      for (const [cwd, s] of sessions) if (s === sid) return cwd
      return null
    }),
    getOrCreateSessionForCwd: vi.fn(async (cwd: string) => {
      const existing = sessions.get(cwd)
      if (existing) return existing
      const sid = `acp-${id}-${sessions.size}`
      sessions.set(cwd, sid)
      return sid
    }),
    _sessions: sessions,
  } as unknown as AcpWorker
}

const createMockPool = (workers?: AcpWorker[]): AcpPool => {
  const available = workers ? [...workers] : [createMockWorker(0), createMockWorker(1)]
  let acquireIndex = 0
  return {
    acquire: vi.fn(async (cwd: string) => {
      const worker = available[acquireIndex % available.length]!
      acquireIndex++
      const acpSessionId = await (worker as any).getOrCreateSessionForCwd(cwd)
      return { worker, acpSessionId }
    }),
    release: vi.fn(),
  } as unknown as AcpPool
}

const NO_CACHE = { prefixHash: null, prefixTokens: 0 }

describe('SessionManager', () => {
  let sessionManager: SessionManager
  let mockPool: AcpPool

  beforeEach(() => {
    mockPool = createMockPool()
    sessionManager = new SessionManager({ pool: mockPool, idleTimeoutMs: 1000 })
  })

  afterEach(async () => {
    await sessionManager.shutdown()
  })

  describe('acquireForSession', () => {
    it('acquires from pool when no sessionId provided', async () => {
      const result = await sessionManager.acquireForSession(undefined, '/tmp', NO_CACHE)
      expect(result.lease.worker).toBeDefined()
      expect(result.lease.acpSessionId).toMatch(/^acp-/)
      expect(result.isExistingSession).toBe(false)
      expect(mockPool.acquire).toHaveBeenCalledOnce()
    })

    it('first request for sessionId is treated as new session', async () => {
      const result = await sessionManager.acquireForSession('s1', '/tmp', NO_CACHE)
      expect(result.isExistingSession).toBe(false)
    })

    it('subsequent request reuses kiro session when worker still alive', async () => {
      const w0 = createMockWorker(0)
      const pool = createMockPool([w0])
      const sm = new SessionManager({ pool })
      const first = await sm.acquireForSession('s1', '/tmp', NO_CACHE)
      sm.releaseLease(first.lease)
      const second = await sm.acquireForSession('s1', '/tmp', NO_CACHE)
      expect(second.isExistingSession).toBe(true)
      expect(second.lease.acpSessionId).toBe(first.lease.acpSessionId)
      await sm.shutdown()
    })

    it('increments turn count on each acquire', async () => {
      const w0 = createMockWorker(0)
      const pool = createMockPool([w0])
      const sm = new SessionManager({ pool })
      const first = await sm.acquireForSession('s1', '/tmp', NO_CACHE)
      sm.releaseLease(first.lease)
      expect(sm.getSessionInfo('s1')?.turnCount).toBe(1)
      const second = await sm.acquireForSession('s1', '/tmp', NO_CACHE)
      sm.releaseLease(second.lease)
      expect(sm.getSessionInfo('s1')?.turnCount).toBe(2)
      await sm.shutdown()
    })

    it('tracks different sessions independently', async () => {
      await sessionManager.acquireForSession('s1', '/tmp', NO_CACHE)
      await sessionManager.acquireForSession('s2', '/tmp', NO_CACHE)
      expect(sessionManager.getSessionCount()).toBe(2)
    })

    it('reports cache hit when prefix matches a known session', async () => {
      const w0 = createMockWorker(0)
      const pool = createMockPool([w0])
      const sm = new SessionManager({ pool })
      const cacheKey = { prefixHash: 'abc', prefixTokens: 100 }
      const first = await sm.acquireForSession('s1', '/tmp', cacheKey)
      expect(first.cacheHit).toBeNull()
      sm.releaseLease(first.lease)
      // New proxy session, same prefix → cache hit
      const second = await sm.acquireForSession('s2', '/tmp', cacheKey)
      expect(second.cacheHit).not.toBeNull()
      expect(second.cacheHit?.prefixTokens).toBe(100)
      await sm.shutdown()
    })
  })

  describe('releaseLease', () => {
    it('always releases lease back to pool', async () => {
      const result = await sessionManager.acquireForSession('s1', '/tmp', NO_CACHE)
      sessionManager.releaseLease(result.lease)
      expect(mockPool.release).toHaveBeenCalled()
    })
  })

  describe('removeSession', () => {
    it('removes session metadata', async () => {
      await sessionManager.acquireForSession('s1', '/tmp', NO_CACHE)
      expect(sessionManager.hasSession('s1')).toBe(true)
      sessionManager.removeSession('s1')
      expect(sessionManager.hasSession('s1')).toBe(false)
    })

    it('does nothing for unknown session', () => {
      sessionManager.removeSession('nope')
      expect(sessionManager.getSessionCount()).toBe(0)
    })
  })

  describe('getSessionInfo', () => {
    it('returns null for unknown', () => {
      expect(sessionManager.getSessionInfo('nope')).toBeNull()
    })

    it('returns metadata for known session', async () => {
      const before = Date.now()
      await sessionManager.acquireForSession('s1', '/tmp', NO_CACHE)
      const info = sessionManager.getSessionInfo('s1')
      expect(info?.turnCount).toBe(1)
      expect(info?.createdAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('evictIdleSessions', () => {
    it('evicts sessions past idle timeout', async () => {
      const sm = new SessionManager({ pool: mockPool, idleTimeoutMs: 50 })
      await sm.acquireForSession('s1', '/tmp', NO_CACHE)
      expect(sm.hasSession('s1')).toBe(true)
      await new Promise((r) => setTimeout(r, 80))
      sm.startCleanup()
      await new Promise((r) => setTimeout(r, 60))
      expect(sm.hasSession('s1')).toBe(false)
      await sm.shutdown()
    })
  })

  describe('shutdown', () => {
    it('clears all sessions', async () => {
      await sessionManager.acquireForSession('s1', '/tmp', NO_CACHE)
      await sessionManager.shutdown()
      expect(sessionManager.getSessionCount()).toBe(0)
    })
  })
})
