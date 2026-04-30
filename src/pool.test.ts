import { describe, it, expect, vi, beforeEach } from 'vitest'
import AcpPool from './pool.js'

let nextSessionCounter = 0

vi.mock('./acp-worker.js', () => {
  return {
    default: class MockAcpWorker {
      readonly id: number
      private state: 'initializing' | 'ready' | 'dead' = 'initializing'
      private sessions: Map<string, string> = new Map() // cwd -> sessionId
      private inFlight = 0
      private spawnedAt = 0
      private maxConcurrent: number
      private onDeath?: (w: MockAcpWorker) => void
      constructor(options: { id: number; maxConcurrentSessions?: number; onDeath?: (w: MockAcpWorker) => void }) {
        this.id = options.id
        this.maxConcurrent = options.maxConcurrentSessions ?? 8
        this.onDeath = options.onDeath
      }
      async init(): Promise<void> {
        this.state = 'ready'
        this.spawnedAt = Date.now()
      }
      isReady(): boolean { return this.state === 'ready' }
      isDead(): boolean { return this.state === 'dead' }
      getState(): string { return this.state }
      getSessionCount(): number { return this.sessions.size }
      getInFlightCount(): number { return this.inFlight }
      hasCapacity(): boolean { return this.state === 'ready' && this.inFlight < this.maxConcurrent }
      getUptimeMs(): number { return Date.now() - this.spawnedAt }
      async getOrCreateSessionForCwd(cwd: string): Promise<string> {
        const existing = this.sessions.get(cwd)
        if (existing) return existing
        const id = `mock-sess-${nextSessionCounter++}`
        this.sessions.set(cwd, id)
        return id
      }
      getSessionCwd(acpSessionId: string): string | null {
        for (const [cwd, sid] of this.sessions) {
          if (sid === acpSessionId) return cwd
        }
        return null
      }
      removeSession(acpSessionId: string): void {
        for (const [cwd, sid] of this.sessions) {
          if (sid === acpSessionId) this.sessions.delete(cwd)
        }
      }
      async prompt(): Promise<{ stopReason: string }> {
        this.inFlight++
        try { return { stopReason: 'end_turn' } }
        finally { this.inFlight-- }
      }
      // Test helpers:
      _occupy(): void { this.inFlight++ }
      _release(): void { this.inFlight-- }
      _markDead(): void {
        this.state = 'dead'
        this.sessions.clear()
        this.onDeath?.(this)
      }
      kill(): void { this.state = 'dead'; this.sessions.clear() }
      async cancel(): Promise<void> {}
    },
  }
})

describe('AcpPool', () => {
  let pool: AcpPool

  beforeEach(async () => {
    pool = new AcpPool({ size: 2, cwd: '/tmp', kiroCli: 'kiro-cli', hotSpare: false, maxConcurrentSessionsPerWorker: 2 })
    await pool.init()
  })

  it('initializes with the configured number of workers', () => {
    expect(pool.getWorkerCount()).toBe(2)
  })

  it('reports idle workers', () => {
    expect(pool.getIdleCount()).toBe(2)
  })

  it('acquires a lease bound to cwd', async () => {
    const lease = await pool.acquire('/tmp')
    expect(lease.worker).toBeDefined()
    expect(lease.acpSessionId).toMatch(/^mock-sess-/)
  })

  it('reuses session for same cwd on same worker', async () => {
    const lease1 = await pool.acquire('/tmp')
    const lease2 = await pool.acquire('/tmp')
    // Both leases may go to same worker (load balanced); session-per-cwd means same id when same worker
    if (lease1.worker.id === lease2.worker.id) {
      expect(lease1.acpSessionId).toBe(lease2.acpSessionId)
    }
  })

  it('respects per-worker concurrency cap', async () => {
    // Cap=2, size=2 → total 4 in-flight max
    const w0 = await pool.acquire('/a')
    const w1 = await pool.acquire('/b')
    const w2 = await pool.acquire('/c')
    const w3 = await pool.acquire('/d')
    // Force occupancy on all to fill cap
    ;(w0.worker as any)._occupy()
    ;(w1.worker as any)._occupy()
    ;(w2.worker as any)._occupy()
    ;(w3.worker as any)._occupy()
    expect(pool.getInFlightCount()).toBe(4)
  })

  it('queues requests when all workers at capacity', async () => {
    const fastPool = new AcpPool({ size: 1, cwd: '/tmp', kiroCli: 'kiro-cli', hotSpare: false, maxConcurrentSessionsPerWorker: 1, acquireTimeoutMs: 200 })
    await fastPool.init()
    const lease = await fastPool.acquire('/tmp')
    ;(lease.worker as any)._occupy()
    let resolved = false
    const pending = fastPool.acquire('/tmp').then((l) => { resolved = true; return l })
    await new Promise((r) => setTimeout(r, 30))
    expect(resolved).toBe(false)
    ;(lease.worker as any)._release()
    fastPool.release(lease) // drain queue
    await pending
    expect(resolved).toBe(true)
    await fastPool.shutdown()
  })

  it('times out acquire when no workers free', async () => {
    const fastPool = new AcpPool({ size: 1, cwd: '/tmp', kiroCli: 'kiro-cli', hotSpare: false, maxConcurrentSessionsPerWorker: 1, acquireTimeoutMs: 50 })
    await fastPool.init()
    const lease = await fastPool.acquire('/tmp')
    ;(lease.worker as any)._occupy()
    await expect(fastPool.acquire('/tmp')).rejects.toThrow('Worker acquire timeout')
    await fastPool.shutdown()
  })

  it('reports queue length', async () => {
    const fastPool = new AcpPool({ size: 1, cwd: '/tmp', kiroCli: 'kiro-cli', hotSpare: false, maxConcurrentSessionsPerWorker: 1 })
    await fastPool.init()
    const lease = await fastPool.acquire('/tmp')
    ;(lease.worker as any)._occupy()
    expect(fastPool.getQueueLength()).toBe(0)
    const pending = fastPool.acquire('/tmp')
    await new Promise((r) => setTimeout(r, 10))
    expect(fastPool.getQueueLength()).toBe(1)
    ;(lease.worker as any)._release()
    fastPool.release(lease)
    await pending
    await fastPool.shutdown()
  })

  it('rejects acquire after shutdown', async () => {
    await pool.shutdown()
    await expect(pool.acquire('/tmp')).rejects.toThrow('Pool is shut down')
  })

  it('rejects queued requests on shutdown', async () => {
    const fastPool = new AcpPool({ size: 1, cwd: '/tmp', kiroCli: 'kiro-cli', hotSpare: false, maxConcurrentSessionsPerWorker: 1 })
    await fastPool.init()
    const lease = await fastPool.acquire('/tmp')
    ;(lease.worker as any)._occupy()
    const pending = fastPool.acquire('/tmp')
    await fastPool.shutdown()
    await expect(pending).rejects.toThrow('Pool is shutting down')
  })

  it('kills all workers on shutdown', async () => {
    await pool.shutdown()
    expect(pool.getWorkerCount()).toBe(0)
  })

  it('hot-spare mode spawns size+1 workers', async () => {
    const sparePool = new AcpPool({ size: 2, cwd: '/tmp', kiroCli: 'kiro-cli', hotSpare: true, maxConcurrentSessionsPerWorker: 2 })
    await sparePool.init()
    expect(sparePool.getWorkerCount()).toBe(3)
    await sparePool.shutdown()
  })

  it('respawns dead worker via onDeath callback', async () => {
    const lease = await pool.acquire('/tmp')
    ;(lease.worker as any)._markDead()
    // worker count drops, then respawn scheduled async
    expect(pool.getWorkerCount()).toBe(1)
    // wait past min backoff
    await new Promise((r) => setTimeout(r, 1500))
    expect(pool.getWorkerCount()).toBe(2)
  })
})
