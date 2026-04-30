import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import SessionManager from './session-manager.js'
import type AcpPool from './pool.js'
import type AcpWorker from './acp-worker.js'

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const createMockWorker = (id = 0, state: 'idle' | 'busy' | 'dead' = 'idle'): AcpWorker => {
  let currentState = state
  return {
    id,
    getState: vi.fn(() => currentState),
    setState: vi.fn((s: string) => { currentState = s as 'idle' | 'busy' | 'dead' }),
    prompt: vi.fn(),
    cancel: vi.fn(),
    kill: vi.fn(),
  } as unknown as AcpWorker
}

const createMockPool = (workers?: AcpWorker[]): AcpPool => {
  const available = workers ? [...workers] : [createMockWorker(0), createMockWorker(1)]
  let acquireIndex = 0
  return {
    acquire: vi.fn(async () => {
      if (acquireIndex >= available.length) throw new Error('No workers available')
      return available[acquireIndex++]!
    }),
    release: vi.fn(),
  } as unknown as AcpPool
}

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
    it('acquires from pool when no sessionId is provided', async () => {
      const { worker, isExistingSession } = await sessionManager.acquireForSession(undefined)
      expect(worker).toBeDefined()
      expect(isExistingSession).toBe(false)
      expect(mockPool.acquire).toHaveBeenCalledOnce()
    })

    it('acquires from pool on first request for a session', async () => {
      const { worker, isExistingSession } = await sessionManager.acquireForSession('session-1')
      expect(worker).toBeDefined()
      expect(isExistingSession).toBe(false)
      expect(mockPool.acquire).toHaveBeenCalledOnce()
    })

    it('acquires from pool on subsequent requests (no worker pinning)', async () => {
      const first = await sessionManager.acquireForSession('session-1')
      sessionManager.releaseWorker('session-1', first.worker)
      const second = await sessionManager.acquireForSession('session-1')
      expect(second.isExistingSession).toBe(false)
      expect(mockPool.acquire).toHaveBeenCalledTimes(2)
    })

    it('increments turn count on each acquire', async () => {
      const first = await sessionManager.acquireForSession('session-1')
      sessionManager.releaseWorker('session-1', first.worker)
      const infoAfterFirst = sessionManager.getSessionInfo('session-1')
      expect(infoAfterFirst?.turnCount).toBe(1)
      const second = await sessionManager.acquireForSession('session-1')
      sessionManager.releaseWorker('session-1', second.worker)
      const infoAfterSecond = sessionManager.getSessionInfo('session-1')
      expect(infoAfterSecond?.turnCount).toBe(2)
    })

    it('tracks different sessions independently', async () => {
      await sessionManager.acquireForSession('session-1')
      await sessionManager.acquireForSession('session-2')
      expect(sessionManager.getSessionCount()).toBe(2)
    })
  })

  describe('releaseWorker', () => {
    it('always releases worker back to pool', async () => {
      const { worker } = await sessionManager.acquireForSession('session-1')
      sessionManager.releaseWorker('session-1', worker)
      expect(mockPool.release).toHaveBeenCalledWith(worker)
    })

    it('releases to pool when no sessionId', async () => {
      const { worker } = await sessionManager.acquireForSession(undefined)
      sessionManager.releaseWorker(undefined, worker)
      expect(mockPool.release).toHaveBeenCalledWith(worker)
    })
  })

  describe('removeSession', () => {
    it('removes session metadata', async () => {
      await sessionManager.acquireForSession('session-1')
      expect(sessionManager.hasSession('session-1')).toBe(true)
      sessionManager.removeSession('session-1')
      expect(sessionManager.hasSession('session-1')).toBe(false)
    })

    it('does nothing for non-existent session', () => {
      sessionManager.removeSession('nonexistent')
      expect(sessionManager.getSessionCount()).toBe(0)
    })
  })

  describe('hasSession / getSessionCount', () => {
    it('returns false for unknown session', () => {
      expect(sessionManager.hasSession('unknown')).toBe(false)
    })

    it('returns true for known session', async () => {
      await sessionManager.acquireForSession('session-1')
      expect(sessionManager.hasSession('session-1')).toBe(true)
    })

    it('counts sessions correctly', async () => {
      expect(sessionManager.getSessionCount()).toBe(0)
      await sessionManager.acquireForSession('session-1')
      expect(sessionManager.getSessionCount()).toBe(1)
    })
  })

  describe('getSessionInfo', () => {
    it('returns null for unknown session', () => {
      expect(sessionManager.getSessionInfo('unknown')).toBeNull()
    })

    it('returns session metadata', async () => {
      const before = Date.now()
      await sessionManager.acquireForSession('session-1')
      const info = sessionManager.getSessionInfo('session-1')
      expect(info).not.toBeNull()
      expect(info!.turnCount).toBe(1)
      expect(info!.createdAt).toBeGreaterThanOrEqual(before)
      expect(info!.lastAccessedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('evictIdleSessions', () => {
    it('evicts sessions that exceed idle timeout', async () => {
      const sm = new SessionManager({ pool: mockPool, idleTimeoutMs: 50 })
      await sm.acquireForSession('session-1')
      expect(sm.hasSession('session-1')).toBe(true)
      await new Promise((r) => setTimeout(r, 80))
      sm.startCleanup()
      await new Promise((r) => setTimeout(r, 60))
      expect(sm.hasSession('session-1')).toBe(false)
      await sm.shutdown()
    })
  })

  describe('shutdown', () => {
    it('clears all sessions', async () => {
      await sessionManager.acquireForSession('session-1')
      await sessionManager.shutdown()
      expect(sessionManager.getSessionCount()).toBe(0)
    })

    it('stops cleanup timer', async () => {
      sessionManager.startCleanup()
      await sessionManager.shutdown()
      expect(sessionManager.getSessionCount()).toBe(0)
    })
  })

  describe('startCleanup / stopCleanup', () => {
    it('can start and stop cleanup without error', () => {
      sessionManager.startCleanup()
      sessionManager.stopCleanup()
    })

    it('is idempotent for start', () => {
      sessionManager.startCleanup()
      sessionManager.startCleanup()
      sessionManager.stopCleanup()
    })
  })
})
