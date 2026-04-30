import AcpWorker from './acp-worker.js'
import type { AcpWorkerOptions } from './acp-worker.js'

interface AcpPoolOptions {
  readonly size: number
  readonly cwd: string
  readonly kiroCli: string
  readonly acquireTimeoutMs?: number
  readonly maxConcurrentSessionsPerWorker?: number
  readonly hotSpare?: boolean
}

interface Lease {
  readonly worker: AcpWorker
  readonly acpSessionId: string
}

type AcquireResolver = (lease: Lease) => void
type AcquireRejecter = (err: Error) => void

interface QueueEntry {
  cwd: string
  resolve: AcquireResolver
  reject: AcquireRejecter
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000
const RESPAWN_BASE_MS = 1_000
const RESPAWN_MAX_MS = 30_000
const RESPAWN_MAX_ATTEMPTS = 5

class AcpPool {
  private readonly size: number
  private readonly cwd: string
  private readonly kiroCli: string
  private readonly acquireTimeoutMs: number
  private readonly maxConcurrentSessionsPerWorker: number
  private readonly hotSpare: boolean
  private workers: AcpWorker[] = []
  private idle: AcpWorker[] = []
  private queue: QueueEntry[] = []
  private nextWorkerId = 0
  private isShutdown = false
  private respawnAttempts: Map<number, number> = new Map()

  constructor(options: AcpPoolOptions) {
    this.size = options.size
    this.cwd = options.cwd
    this.kiroCli = options.kiroCli
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
    this.maxConcurrentSessionsPerWorker = options.maxConcurrentSessionsPerWorker ?? 8
    this.hotSpare = options.hotSpare ?? true
  }

  async init(): Promise<void> {
    const initPromises: Array<Promise<void>> = []
    const target = this.hotSpare ? this.size + 1 : this.size
    for (let i = 0; i < target; i++) {
      initPromises.push(this.spawnWorker())
    }
    await Promise.all(initPromises)
    console.log(`[pool] initialized with ${this.workers.length} workers (size=${this.size}, hotSpare=${this.hotSpare})`)
  }

  /**
   * Acquire a session-bound lease. Picks worker with capacity for given cwd.
   * Reuses an existing matching session in the worker, or creates new one.
   */
  async acquire(cwd: string): Promise<Lease> {
    if (this.isShutdown) throw new Error('Pool is shut down')
    const ready = this.pickReadyWorker()
    if (ready) {
      return this.leaseOnWorker(ready, cwd)
    }
    return new Promise<Lease>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.timer === timer)
        if (idx !== -1) this.queue.splice(idx, 1)
        reject(new Error('Worker acquire timeout'))
      }, this.acquireTimeoutMs)
      this.queue.push({ cwd, resolve, reject, timer })
    })
  }

  release(lease: Lease): void {
    if (this.isShutdown) return
    if (lease.worker.isDead()) return
    this.drainQueue()
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true
    for (const pending of this.queue) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Pool is shutting down'))
    }
    this.queue = []
    for (const worker of this.workers) {
      worker.kill()
    }
    this.workers = []
    this.idle = []
    console.log('[pool] shut down')
  }

  getWorkerCount(): number {
    return this.workers.length
  }

  getIdleCount(): number {
    let n = 0
    for (const w of this.workers) if (w.isReady() && w.getInFlightCount() === 0) n++
    return n
  }

  getQueueLength(): number {
    return this.queue.length
  }

  /** Total in-flight prompts across all workers. */
  getInFlightCount(): number {
    let n = 0
    for (const w of this.workers) n += w.getInFlightCount()
    return n
  }

  /** Pick the worker with capacity and the lowest in-flight load. */
  private pickReadyWorker(): AcpWorker | null {
    let best: AcpWorker | null = null
    let bestLoad = Infinity
    for (const w of this.workers) {
      if (!w.hasCapacity()) continue
      const load = w.getInFlightCount()
      if (load < bestLoad) {
        bestLoad = load
        best = w
        if (load === 0) break
      }
    }
    return best
  }

  private async leaseOnWorker(worker: AcpWorker, cwd: string): Promise<Lease> {
    const acpSessionId = await worker.getOrCreateSessionForCwd(cwd)
    return { worker, acpSessionId }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const ready = this.pickReadyWorker()
      if (!ready) return
      const next = this.queue.shift()!
      clearTimeout(next.timer)
      this.leaseOnWorker(ready, next.cwd).then(next.resolve).catch(next.reject)
    }
  }

  private async spawnWorker(): Promise<void> {
    const id = this.nextWorkerId++
    const options: AcpWorkerOptions = {
      id,
      kiroCli: this.kiroCli,
      cwd: this.cwd,
      maxConcurrentSessions: this.maxConcurrentSessionsPerWorker,
      onDeath: (dead) => this.onWorkerDeath(dead),
    }
    const worker = new AcpWorker(options)
    this.workers.push(worker)
    try {
      await worker.init()
      this.respawnAttempts.delete(id)
      this.drainQueue()
    } catch (err) {
      console.error(`[pool] worker ${id} init failed: ${err}`)
      this.removeWorker(worker)
      this.scheduleRespawn(id)
    }
  }

  private removeWorker(worker: AcpWorker): void {
    const idx = this.workers.indexOf(worker)
    if (idx !== -1) this.workers.splice(idx, 1)
  }

  private onWorkerDeath(worker: AcpWorker): void {
    if (this.isShutdown) return
    console.log(`[pool] worker ${worker.id} died`)
    this.removeWorker(worker)
    this.scheduleRespawn(worker.id)
  }

  private scheduleRespawn(deadId: number): void {
    if (this.isShutdown) return
    const target = this.hotSpare ? this.size + 1 : this.size
    if (this.workers.length >= target) return
    const attempts = (this.respawnAttempts.get(deadId) ?? 0) + 1
    this.respawnAttempts.set(deadId, attempts)
    if (attempts > RESPAWN_MAX_ATTEMPTS) {
      console.error(`[pool] worker ${deadId} exceeded ${RESPAWN_MAX_ATTEMPTS} respawn attempts; giving up`)
      this.respawnAttempts.delete(deadId)
      return
    }
    const base = Math.min(RESPAWN_BASE_MS * 2 ** (attempts - 1), RESPAWN_MAX_MS)
    const jitter = Math.floor(Math.random() * base * 0.3)
    const delay = base + jitter
    console.log(`[pool] respawning replacement worker (attempt ${attempts}, delay ${delay}ms)`)
    setTimeout(() => {
      if (this.isShutdown) return
      this.spawnWorker().catch((err) => {
        console.error(`[pool] respawn failed: ${err}`)
      })
    }, delay)
  }
}

export default AcpPool
export type { AcpPoolOptions, Lease }
