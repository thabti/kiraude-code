import type AcpWorker from './acp-worker.js'
import type AcpPool from './pool.js'
import type { Lease } from './pool.js'
import PromptCacheRegistry from './prompt-cache.js'
import type { CacheKey } from './prompt-cache.js'
import logger from './logger.js'

interface SessionEntry {
  readonly proxySessionId: string
  workerId: number | null
  acpSessionId: string | null
  cwd: string
  readonly createdAt: number
  lastAccessedAt: number
  turnCount: number
  /** Once cache_control eligibility is set, latch it for the session to
   *  avoid mid-session cache-busting. */
  cacheEligible: boolean | null
}

interface SessionManagerOptions {
  readonly pool: AcpPool
  readonly idleTimeoutMs?: number
  readonly maxSessions?: number
  readonly promptCache?: PromptCacheRegistry
}

interface AcquireResult {
  readonly lease: Lease
  /** True if the underlying ACP session existed before this acquire,
   *  meaning prior context lives in kiro and only the last turn is needed. */
  readonly isExistingSession: boolean
  /** Cache hit info — set when acquire reused a session matching prefixHash. */
  readonly cacheHit: { prefixHash: string; prefixTokens: number } | null
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_MAX_SESSIONS = 200

class SessionManager {
  private readonly pool: AcpPool
  private readonly idleTimeoutMs: number
  private readonly maxSessions: number
  private readonly promptCache: PromptCacheRegistry
  private readonly sessions: Map<string, SessionEntry> = new Map()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: SessionManagerOptions) {
    this.pool = options.pool
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.promptCache = options.promptCache ?? new PromptCacheRegistry()
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
   * Acquire a worker lease for a request. Reuses ACP session when possible:
   *   1. Same proxySessionId as a prior request → reuse same ACP session.
   *   2. cache_control prefix matches a known kiro session → reuse it.
   *   3. Otherwise create new session (in any worker with capacity).
   */
  async acquireForSession(
    proxySessionId: string | undefined,
    cwd: string,
    cacheKey: CacheKey,
  ): Promise<AcquireResult> {
    if (proxySessionId) {
      const existing = this.sessions.get(proxySessionId)
      if (existing && existing.acpSessionId && existing.workerId !== null) {
        const lease = await this.pool.acquire(cwd)
        if (lease.worker.id === existing.workerId &&
            lease.worker.getSessionCwd(existing.acpSessionId) === existing.cwd) {
          existing.lastAccessedAt = Date.now()
          existing.turnCount++
          if (cacheKey.prefixHash) {
            this.promptCache.record(cacheKey.prefixHash, existing.acpSessionId, existing.workerId, cacheKey.prefixTokens)
          }
          return {
            lease: { worker: lease.worker, acpSessionId: existing.acpSessionId },
            isExistingSession: true,
            cacheHit: cacheKey.prefixHash
              ? { prefixHash: cacheKey.prefixHash, prefixTokens: cacheKey.prefixTokens }
              : null,
          }
        }
        // worker died or session lost — fall through, treat as new
        existing.acpSessionId = null
        existing.workerId = null
      }
    }
    if (cacheKey.prefixHash) {
      const cached = this.promptCache.lookup(cacheKey.prefixHash)
      if (cached) {
        const lease = await this.pool.acquire(cwd)
        if (lease.worker.id === cached.workerId &&
            lease.worker.getSessionCwd(cached.acpSessionId) !== null) {
          if (proxySessionId) this.upsertSessionEntry(proxySessionId, cwd, cached.acpSessionId, cached.workerId)
          return {
            lease: { worker: lease.worker, acpSessionId: cached.acpSessionId },
            isExistingSession: true,
            cacheHit: { prefixHash: cacheKey.prefixHash, prefixTokens: cached.prefixTokens },
          }
        }
        this.promptCache.invalidateSession(cached.acpSessionId)
      }
    }
    const lease = await this.pool.acquire(cwd)
    if (proxySessionId) {
      this.upsertSessionEntry(proxySessionId, cwd, lease.acpSessionId, lease.worker.id)
    }
    if (cacheKey.prefixHash) {
      this.promptCache.record(cacheKey.prefixHash, lease.acpSessionId, lease.worker.id, cacheKey.prefixTokens)
    }
    return { lease, isExistingSession: false, cacheHit: null }
  }

  releaseLease(lease: Lease): void {
    this.pool.release(lease)
  }

  removeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (entry?.acpSessionId) this.promptCache.invalidateSession(entry.acpSessionId)
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

  private upsertSessionEntry(proxySessionId: string, cwd: string, acpSessionId: string, workerId: number): void {
    const existing = this.sessions.get(proxySessionId)
    if (existing) {
      existing.acpSessionId = acpSessionId
      existing.workerId = workerId
      existing.cwd = cwd
      existing.lastAccessedAt = Date.now()
      existing.turnCount++
      return
    }
    this.ensureCapacity()
    this.sessions.set(proxySessionId, {
      proxySessionId,
      workerId,
      acpSessionId,
      cwd,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      turnCount: 1,
      cacheEligible: null,
    })
  }

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
      const e = this.sessions.get(oldestKey)
      if (e?.acpSessionId) this.promptCache.invalidateSession(e.acpSessionId)
      this.sessions.delete(oldestKey)
      logger.info({ sessionId: oldestKey }, 'session evicted (LRU, at capacity)')
    }
  }

  private evictIdleSessions(): void {
    const now = Date.now()
    for (const [sessionId, entry] of this.sessions) {
      if (now - entry.lastAccessedAt > this.idleTimeoutMs) {
        if (entry.acpSessionId) this.promptCache.invalidateSession(entry.acpSessionId)
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
export type { SessionManagerOptions, SessionEntry, AcquireResult }
