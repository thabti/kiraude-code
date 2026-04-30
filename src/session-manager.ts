import type AcpWorker from './acp-worker.js'
import type AcpPool from './pool.js'
import logger from './logger.js'

interface SessionEntry {
  readonly createdAt: number
  lastAccessedAt: number
  turnCount: number
}

interface SessionManagerOptions {
  readonly pool: AcpPool
  readonly idleTimeoutMs?: number
  readonly maxSessions?: number
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000 // 5 minutes
const DEFAULT_MAX_SESSIONS = 100

/**
 * Lightweight session tracker. Sessions are metadata only — no worker pinning.
 * Workers are acquired from the pool per-request and released back after.
 */
class SessionManager {
  private readonly pool: AcpPool
  private readonly idleTimeoutMs: number
  private readonly maxSessions: number
  private readonly sessions: Map<string, SessionEntry> = new Map()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: SessionManagerOptions) {
    this.pool = options.pool
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  }

  startCleanup(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => this.evictIdleSessions(), this.idleTimeoutMs / 2)
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /**
   * Acquires a worker from the pool for this request. Session metadata is
   * tracked but workers are not pinned — every request gets a fresh acquire.
   */
  async acquireForSession(sessionId: string | undefined): Promise<{ worker: AcpWorker; isExistingSession: boolean }> {
    const worker = await this.pool.acquire()
    if (!sessionId) {
      return { worker, isExistingSession: false }
    }
    const existing = this.sessions.get(sessionId)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      existing.turnCount++
      return { worker, isExistingSession: false }
    }
    this.ensureCapacity()
    this.sessions.set(sessionId, {
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      turnCount: 1,
    })
    return { worker, isExistingSession: false }
  }

  /** Releases the worker back to the pool. */
  releaseWorker(_sessionId: string | undefined, worker: AcpWorker): void {
    this.pool.release(worker)
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  getSessionInfo(sessionId: string): { turnCount: number; createdAt: number; lastAccessedAt: number } | null {
    const entry = this.sessions.get(sessionId)
    if (!entry) return null
    return { turnCount: entry.turnCount, createdAt: entry.createdAt, lastAccessedAt: entry.lastAccessedAt }
  }

  /** Evict the least-recently-used session when at capacity. */
  private ensureCapacity(): void {
    if (this.sessions.size < this.maxSessions) return
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, entry] of this.sessions) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt
        oldestKey = key
      }
    }
    if (oldestKey) {
      this.sessions.delete(oldestKey)
      logger.info({ sessionId: oldestKey }, 'session evicted (LRU, at capacity)')
    }
  }

  private evictIdleSessions(): void {
    const now = Date.now()
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastAccessedAt > this.idleTimeoutMs) {
        this.sessions.delete(sessionId)
        logger.info({ sessionId }, 'session evicted (idle)')
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopCleanup()
    this.sessions.clear()
  }
}

export default SessionManager
export type { SessionManagerOptions, SessionEntry }
