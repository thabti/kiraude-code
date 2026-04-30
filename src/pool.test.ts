import { describe, it, expect, vi, beforeEach } from 'vitest'
import AcpPool from './pool.js'

// Mock AcpWorker since it spawns real subprocesses
vi.mock('./acp-worker.js', () => {
  return {
    default: class MockAcpWorker {
      readonly id: number
      private state: 'idle' | 'busy' | 'dead' = 'idle'
      constructor(options: { id: number }) {
        this.id = options.id
      }
      async init(): Promise<void> {}
      getState(): string { return this.state }
      setState(state: 'idle' | 'busy' | 'dead'): void { this.state = state }
      kill(): void { this.state = 'dead' }
    },
  }
})

describe('AcpPool', () => {
  let pool: AcpPool

  beforeEach(async () => {
    pool = new AcpPool({ size: 2, cwd: '/tmp', kiroCli: 'kiro-cli' })
    await pool.init()
  })

  it('initializes with the correct number of workers', () => {
    expect(pool.getWorkerCount()).toBe(2)
  })

  it('reports idle workers', () => {
    expect(pool.getIdleCount()).toBe(2)
  })

  it('acquires an idle worker', async () => {
    const actualWorker = await pool.acquire()
    expect(actualWorker).toBeDefined()
    expect(actualWorker.getState()).toBe('busy')
    expect(pool.getIdleCount()).toBe(1)
  })

  it('releases a worker back to idle', async () => {
    const actualWorker = await pool.acquire()
    pool.release(actualWorker)
    expect(actualWorker.getState()).toBe('idle')
    expect(pool.getIdleCount()).toBe(2)
  })

  it('queues requests when all workers are busy', async () => {
    const worker1 = await pool.acquire()
    const worker2 = await pool.acquire()
    let resolved = false
    const pendingAcquire = pool.acquire().then((w) => { resolved = true; return w })
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)
    pool.release(worker1)
    const actualWorker = await pendingAcquire
    expect(resolved).toBe(true)
    expect(actualWorker).toBeDefined()
    pool.release(worker2)
  })

  it('times out acquire when no workers become available', async () => {
    const fastPool = new AcpPool({ size: 1, cwd: '/tmp', kiroCli: 'kiro-cli', acquireTimeoutMs: 50 })
    await fastPool.init()
    const _worker = await fastPool.acquire()
    await expect(fastPool.acquire()).rejects.toThrow('Worker acquire timeout')
    await fastPool.shutdown()
  })

  it('replaces dead workers on release', async () => {
    const worker = await pool.acquire()
    worker.setState('dead')
    pool.release(worker)
    await new Promise((r) => setTimeout(r, 50))
    expect(pool.getWorkerCount()).toBe(2)
  })

  it('reports queue length', async () => {
    const w1 = await pool.acquire()
    const _w2 = await pool.acquire()
    expect(pool.getQueueLength()).toBe(0)
    const pending = pool.acquire()
    await new Promise((r) => setTimeout(r, 10))
    expect(pool.getQueueLength()).toBe(1)
    pool.release(w1)
    await pending
    await pool.shutdown()
  })

  it('rejects acquire after shutdown', async () => {
    await pool.shutdown()
    await expect(pool.acquire()).rejects.toThrow('Pool is shut down')
  })

  it('rejects queued requests on shutdown', async () => {
    const _worker1 = await pool.acquire()
    const _worker2 = await pool.acquire()
    const pendingAcquire = pool.acquire()
    await pool.shutdown()
    await expect(pendingAcquire).rejects.toThrow('Pool is shutting down')
  })

  it('kills all workers on shutdown', async () => {
    await pool.shutdown()
    expect(pool.getWorkerCount()).toBe(0)
  })
})
