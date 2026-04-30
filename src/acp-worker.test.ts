import { describe, it, expect, afterEach } from 'vitest'
import AcpWorker, { buildSpawnArgs } from './acp-worker.js'

describe('AcpWorker', () => {
  describe('constructor and state management', () => {
    it('initializes with idle state', () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      expect(worker.getState()).toBe('idle')
    })

    it('stores the worker id', () => {
      const worker = new AcpWorker({ id: 42, kiroCli: 'kiro-cli', cwd: '/tmp' })
      expect(worker.id).toBe(42)
    })

    it('returns null sessionId before init', () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      expect(worker.getSessionId()).toBeNull()
    })

    it('allows setting state', () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      worker.setState('busy')
      expect(worker.getState()).toBe('busy')
      worker.setState('dead')
      expect(worker.getState()).toBe('dead')
    })
  })

  describe('kill', () => {
    it('sets state to dead', () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      worker.kill()
      expect(worker.getState()).toBe('dead')
    })

    it('clears sessionId', () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      worker.kill()
      expect(worker.getSessionId()).toBeNull()
    })

    it('can be called multiple times safely', () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      worker.kill()
      worker.kill()
      expect(worker.getState()).toBe('dead')
    })
  })

  describe('prompt without init', () => {
    it('throws when not initialized', async () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      await expect(worker.prompt([{ type: 'text', text: 'hello' }])).rejects.toThrow('not initialized')
    })

    it('throws when dead', async () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      worker.setState('dead')
      await expect(worker.prompt([{ type: 'text', text: 'hello' }])).rejects.toThrow('not initialized')
    })
  })

  describe('cancel without init', () => {
    it('resolves silently when not initialized', async () => {
      const worker = new AcpWorker({ id: 0, kiroCli: 'kiro-cli', cwd: '/tmp' })
      await expect(worker.cancel()).resolves.toBeUndefined()
    })
  })
})

describe('buildSpawnArgs', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('defaults to --trust-all-tools when no env vars set', () => {
    delete process.env.TRUST_TOOLS
    delete process.env.TRUST_ALL_TOOLS
    expect(buildSpawnArgs()).toEqual(['acp', '--trust-all-tools'])
  })

  it('uses --trust-all-tools when TRUST_ALL_TOOLS is true', () => {
    process.env.TRUST_ALL_TOOLS = 'true'
    delete process.env.TRUST_TOOLS
    expect(buildSpawnArgs()).toEqual(['acp', '--trust-all-tools'])
  })

  it('omits --trust-all-tools when TRUST_ALL_TOOLS is false', () => {
    process.env.TRUST_ALL_TOOLS = 'false'
    delete process.env.TRUST_TOOLS
    expect(buildSpawnArgs()).toEqual(['acp'])
  })

  it('uses --trust-tools when TRUST_TOOLS is set', () => {
    process.env.TRUST_TOOLS = 'fs_read,fs_write'
    expect(buildSpawnArgs()).toEqual(['acp', '--trust-tools', 'fs_read,fs_write'])
  })

  it('TRUST_TOOLS takes precedence over TRUST_ALL_TOOLS', () => {
    process.env.TRUST_TOOLS = 'execute_bash'
    process.env.TRUST_ALL_TOOLS = 'true'
    expect(buildSpawnArgs()).toEqual(['acp', '--trust-tools', 'execute_bash'])
  })

  it('trims whitespace from TRUST_TOOLS', () => {
    process.env.TRUST_TOOLS = '  fs_read  '
    expect(buildSpawnArgs()).toEqual(['acp', '--trust-tools', 'fs_read'])
  })

  it('ignores empty TRUST_TOOLS and falls back to --trust-all-tools', () => {
    process.env.TRUST_TOOLS = '   '
    delete process.env.TRUST_ALL_TOOLS
    expect(buildSpawnArgs()).toEqual(['acp', '--trust-all-tools'])
  })
})
