import AcpWorker from './acp-worker.js'
import type { AcpWorkerOptions } from './acp-worker.js'

interface AcpPoolOptions {
  readonly size: number
  readonly cwd: string
  readonly kiroCli: string
  readonly acquireTimeoutMs?: number
}

type AcquireResolver = (worker: AcpWorker) => void
type AcquireRejecter = (err: Error) => void

interface QueueEntry {
  resolve: AcquireResolver
  reject: AcquireRejecter
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000

class AcpPool {
  private readonly size: number
  private readonly cwd: string
  private readonly kiroCli: string
  private readonly acquireTimeoutMs: number
  private workers: AcpWorker[] = []
  private queue: QueueEntry[] = []
  private nextWorkerId = 0
  private isShutdown = false

  constructor(options: AcpPoolOptions) {
    this.size = options.size
    this.cwd = options.cwd
    this.kiroCli = options.kiroCli
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS
  }

  async init(): Promise<void> {
    const initPromises: Array<Promise<void>> = []
    for (let i = 0; i < this.size; i++) {
      initPromises.push(this.spawnWorker())
    }
    await Promise.all(initPromises)
    console.log(`[pool] initialized with ${this.workers.length} workers`)
  }

  async acquire(): Promise<AcpWorker> {
    if (this.isShutdown) throw new Error('Pool is shut down')
    const idle = this.workers.find((w) => w.getState() === 'idle')
    if (idle) {
      idle.setState('busy')
      return idle
    }
    return new Promise<AcpWorker>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.timer === timer)
        if (idx !== -1) this.queue.splice(idx, 1)
        reject(new Error('Worker acquire timeout'))
      }, this.acquireTimeoutMs)
      this.queue.push({ resolve, reject, timer })
    })
  }

  release(worker: AcpWorker): void {
    if (this.isShutdown) return
    if (worker.getState() === 'dead') {
      this.replaceDeadWorker(worker)
      return
    }
    worker.setState('idle')
    this.drainQueue(worker)
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
    console.log('[pool] shut down')
  }

  getWorkerCount(): number {
    return this.workers.length
  }

  getIdleCount(): number {
    return this.workers.filter((w) => w.getState() === 'idle').length
  }

  getQueueLength(): number {
    return this.queue.length
  }

  private drainQueue(worker: AcpWorker): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      clearTimeout(next.timer)
      worker.setState('busy')
      next.resolve(worker)
    }
  }

  private async spawnWorker(): Promise<void> {
    const id = this.nextWorkerId++
    const options: AcpWorkerOptions = {
      id,
      kiroCli: this.kiroCli,
      cwd: this.cwd,
    }
    const worker = new AcpWorker(options)
    this.workers.push(worker)
    await worker.init()
    this.monitorWorker(worker)
  }

  private monitorWorker(worker: AcpWorker): void {
    const checkInterval = setInterval(() => {
      if (this.isShutdown) {
        clearInterval(checkInterval)
        return
      }
      if (worker.getState() === 'dead') {
        clearInterval(checkInterval)
        this.replaceDeadWorker(worker)
      }
    }, 1000)
  }

  private replaceDeadWorker(worker: AcpWorker): void {
    console.log(`[pool] replacing dead worker ${worker.id}`)
    const index = this.workers.indexOf(worker)
    if (index !== -1) {
      this.workers.splice(index, 1)
    }
    this.spawnWorker().then(() => {
      const newWorker = this.workers[this.workers.length - 1]
      if (newWorker && this.queue.length > 0 && newWorker.getState() === 'idle') {
        const next = this.queue.shift()!
        clearTimeout(next.timer)
        newWorker.setState('busy')
        next.resolve(newWorker)
      }
    }).catch((err) => {
      console.error(`[pool] failed to replace worker: ${err}`)
    })
  }
}

export default AcpPool
export type { AcpPoolOptions }
