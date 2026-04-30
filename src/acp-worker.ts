import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import * as acp from '@agentclientprotocol/sdk'
import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  PromptResponse,
  ContentBlock,
  SessionUpdate,
} from '@agentclientprotocol/sdk'

type WorkerState = 'initializing' | 'ready' | 'dead'

type SessionUpdateCallback = (update: SessionUpdate) => void

interface AcpWorkerOptions {
  readonly id: number
  readonly kiroCli: string
  readonly cwd: string
  readonly maxConcurrentSessions?: number
  readonly onDeath?: (worker: AcpWorker) => void
}

interface SessionSlot {
  readonly acpSessionId: string
  cwd: string
  currentModelId: string | null
  inFlight: boolean
  onUpdate: SessionUpdateCallback | null
  lastUsedAt: number
}

const MAX_TERMINAL_OUTPUT_BYTES = 512_000
const TERMINAL_SPILL_THRESHOLD_BYTES = 256_000
const SPILL_DIR = path.join(os.tmpdir(), 'kiraude-spill')

const buildSpawnArgs = (): string[] => {
  const args = ['acp']
  const trustTools = process.env.TRUST_TOOLS?.trim()
  if (trustTools) {
    args.push('--trust-tools', trustTools)
  } else if (process.env.TRUST_ALL_TOOLS !== 'false') {
    args.push('--trust-all-tools')
  }
  return args
}

class AcpWorker {
  readonly id: number
  private readonly kiroCli: string
  private readonly defaultCwd: string
  private readonly maxConcurrentSessions: number
  private readonly onDeath: ((worker: AcpWorker) => void) | undefined
  private process: ChildProcess | null = null
  private connection: acp.ClientSideConnection | null = null
  private state: WorkerState = 'initializing'
  private sessions: Map<string, SessionSlot> = new Map()
  private sessionsByCwd: Map<string, string> = new Map()
  private terminals: Map<string, ChildProcess> = new Map()
  private terminalOutputs: Map<string, Buffer[]> = new Map()
  private terminalOutputBytes: Map<string, number> = new Map()
  private terminalExitStatuses: Map<string, { exitCode: number | null; signal: string | null }> = new Map()
  private terminalWaiters: Map<string, Array<(status: { exitCode: number | null; signal: string | null }) => void>> = new Map()
  private nextTerminalId = 0
  private spawnedAt = 0

  constructor(options: AcpWorkerOptions) {
    this.id = options.id
    this.kiroCli = options.kiroCli
    this.defaultCwd = options.cwd
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? 8
    this.onDeath = options.onDeath
  }

  getState(): WorkerState {
    return this.state
  }

  isReady(): boolean {
    return this.state === 'ready'
  }

  isDead(): boolean {
    return this.state === 'dead'
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  getInFlightCount(): number {
    let n = 0
    for (const s of this.sessions.values()) {
      if (s.inFlight) n++
    }
    return n
  }

  hasCapacity(): boolean {
    return this.state === 'ready' && this.getInFlightCount() < this.maxConcurrentSessions
  }

  getUptimeMs(): number {
    return Date.now() - this.spawnedAt
  }

  async init(): Promise<void> {
    this.spawnedAt = Date.now()
    const args = buildSpawnArgs()
    console.log(`[worker-${this.id}] spawning: ${this.kiroCli} ${args.join(' ')}`)
    const child = spawn(this.kiroCli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.defaultCwd,
    })
    this.process = child
    child.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[worker-${this.id}] ${chunk.toString().trimEnd()}`)
    })
    child.on('exit', (code, signal) => {
      console.error(`[worker-${this.id}] process exited (code=${code}, signal=${signal})`)
      this.markDead()
    })
    child.on('error', (err) => {
      console.error(`[worker-${this.id}] process error: ${err}`)
      this.markDead()
    })
    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>
    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    const stream = acp.ndJsonStream(output, input)
    const client = this.createClient()
    this.connection = new acp.ClientSideConnection((_agent) => client, stream)
    const initResult = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })
    console.log(`[worker-${this.id}] initialized (protocol v${initResult.protocolVersion})`)
    this.state = 'ready'
  }

  /**
   * Create new ACP session with given cwd. Returns the proxy session key
   * (acpSessionId). One worker holds many sessions concurrently.
   */
  async createSession(cwd: string): Promise<string> {
    if (!this.connection) throw new Error(`Worker ${this.id} not initialized`)
    if (this.state === 'dead') throw new Error(`Worker ${this.id} is dead`)
    const result = await this.connection.newSession({ cwd, mcpServers: [] })
    const slot: SessionSlot = {
      acpSessionId: result.sessionId,
      cwd,
      currentModelId: null,
      inFlight: false,
      onUpdate: null,
      lastUsedAt: Date.now(),
    }
    this.sessions.set(result.sessionId, slot)
    this.sessionsByCwd.set(cwd, result.sessionId)
    return result.sessionId
  }

  /** Find existing session matching cwd, or create one. */
  async getOrCreateSessionForCwd(cwd: string): Promise<string> {
    const existing = this.sessionsByCwd.get(cwd)
    if (existing && this.sessions.has(existing)) return existing
    return this.createSession(cwd)
  }

  getSessionCwd(acpSessionId: string): string | null {
    return this.sessions.get(acpSessionId)?.cwd ?? null
  }

  removeSession(acpSessionId: string): void {
    const slot = this.sessions.get(acpSessionId)
    if (!slot) return
    this.sessions.delete(acpSessionId)
    if (this.sessionsByCwd.get(slot.cwd) === acpSessionId) {
      this.sessionsByCwd.delete(slot.cwd)
    }
  }

  async prompt(
    acpSessionId: string,
    content: Array<ContentBlock>,
    onUpdate?: SessionUpdateCallback,
    modelId?: string,
  ): Promise<PromptResponse> {
    if (!this.connection) throw new Error(`Worker ${this.id} not initialized`)
    if (this.state === 'dead') throw new Error(`Worker ${this.id} is dead`)
    const slot = this.sessions.get(acpSessionId)
    if (!slot) throw new Error(`Session ${acpSessionId} unknown to worker ${this.id}`)
    if (slot.inFlight) throw new Error(`Session ${acpSessionId} already has prompt in flight`)
    slot.inFlight = true
    slot.onUpdate = onUpdate ?? null
    slot.lastUsedAt = Date.now()
    try {
      if (modelId && modelId !== slot.currentModelId) {
        try {
          await this.connection.unstable_setSessionModel({ sessionId: acpSessionId, modelId })
          slot.currentModelId = modelId
        } catch (err) {
          console.warn(`[worker-${this.id}] setSessionModel failed: ${err}`)
        }
      }
      const result = await this.connection.prompt({ sessionId: acpSessionId, prompt: content })
      return result
    } finally {
      slot.onUpdate = null
      slot.inFlight = false
      slot.lastUsedAt = Date.now()
      this.cleanupCompletedTerminals()
    }
  }

  async cancel(acpSessionId: string): Promise<void> {
    if (!this.connection) return
    if (!this.sessions.has(acpSessionId)) return
    await this.connection.cancel({ sessionId: acpSessionId })
  }

  private cleanupCompletedTerminals(): void {
    for (const [terminalId, status] of this.terminalExitStatuses) {
      if (status.exitCode !== null || status.signal !== null) {
        this.terminals.delete(terminalId)
        this.terminalOutputs.delete(terminalId)
        this.terminalOutputBytes.delete(terminalId)
        this.terminalExitStatuses.delete(terminalId)
        this.terminalWaiters.delete(terminalId)
      }
    }
  }

  private markDead(): void {
    if (this.state === 'dead') return
    this.state = 'dead'
    this.connection = null
    this.sessions.clear()
    this.sessionsByCwd.clear()
    if (this.onDeath) this.onDeath(this)
  }

  kill(): void {
    if (this.process) {
      try { this.process.kill() } catch { /* ignore */ }
      this.process = null
    }
    this.state = 'dead'
    this.connection = null
    this.sessions.clear()
    this.sessionsByCwd.clear()
    for (const proc of this.terminals.values()) {
      try { proc.kill() } catch { /* ignore */ }
    }
    this.terminals.clear()
    this.terminalOutputs.clear()
    this.terminalOutputBytes.clear()
    this.terminalExitStatuses.clear()
    this.terminalWaiters.clear()
  }

  private routeUpdate(notification: SessionNotification): void {
    const slot = this.sessions.get(notification.sessionId)
    if (slot?.onUpdate) {
      try {
        slot.onUpdate(notification.update)
      } catch (err) {
        console.error(`[worker-${this.id}] onUpdate callback threw: ${err}`)
      }
    }
  }

  private appendTerminalOutput(terminalId: string, chunk: Buffer, byteLimit: number): void {
    const chunks = this.terminalOutputs.get(terminalId)
    if (!chunks) return
    chunks.push(chunk)
    const newSize = (this.terminalOutputBytes.get(terminalId) ?? 0) + chunk.byteLength
    this.terminalOutputBytes.set(terminalId, newSize)
    while ((this.terminalOutputBytes.get(terminalId) ?? 0) > byteLimit && chunks.length > 1) {
      const dropped = chunks.shift()!
      this.terminalOutputBytes.set(terminalId, (this.terminalOutputBytes.get(terminalId) ?? 0) - dropped.byteLength)
    }
  }

  private async readTerminalOutput(terminalId: string): Promise<{ output: string; truncated: boolean }> {
    const chunks = this.terminalOutputs.get(terminalId) ?? []
    const totalBytes = this.terminalOutputBytes.get(terminalId) ?? 0
    if (totalBytes <= TERMINAL_SPILL_THRESHOLD_BYTES) {
      return { output: Buffer.concat(chunks).toString('utf8'), truncated: false }
    }
    try {
      await fs.mkdir(SPILL_DIR, { recursive: true })
      const spillPath = path.join(SPILL_DIR, `${terminalId}-${Date.now()}.txt`)
      await fs.writeFile(spillPath, Buffer.concat(chunks))
      const head = chunks[0]?.toString('utf8').slice(0, 4000) ?? ''
      const last = chunks[chunks.length - 1]?.toString('utf8').slice(-4000) ?? ''
      const preview =
        `[output ${totalBytes} bytes — full content spilled to ${spillPath}]\n` +
        `--- HEAD ---\n${head}\n--- TAIL ---\n${last}`
      return { output: preview, truncated: true }
    } catch (err) {
      console.warn(`[worker-${this.id}] spill failed: ${err}`)
      return { output: Buffer.concat(chunks).toString('utf8').slice(-MAX_TERMINAL_OUTPUT_BYTES), truncated: true }
    }
  }

  private createClient(): acp.Client {
    return {
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const allowOption = params.options.find((o) => o.kind === 'allow_once')
          ?? params.options.find((o) => o.kind === 'allow_always')
          ?? params.options[0]
        return Promise.resolve({
          outcome: { outcome: 'selected', optionId: allowOption!.optionId },
        })
      },
      sessionUpdate: (params: SessionNotification): Promise<void> => {
        this.routeUpdate(params)
        return Promise.resolve()
      },
      readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        const content = await fs.readFile(params.path, 'utf-8')
        if (params.line != null || params.limit != null) {
          const lines = content.split('\n')
          const startLine = (params.line ?? 1) - 1
          const endLine = params.limit != null ? startLine + params.limit : lines.length
          return { content: lines.slice(startLine, endLine).join('\n') }
        }
        return { content }
      },
      writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        await fs.writeFile(params.path, params.content, 'utf-8')
        return {}
      },
      createTerminal: (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
        const terminalId = `term-${this.id}-${this.nextTerminalId++}`
        const slot = params.cwd ? null : this.sessions.values().next().value
        const cwd = params.cwd ?? slot?.cwd ?? this.defaultCwd
        const child = spawn(params.command, params.args ?? [], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: params.env
            ? { ...process.env, ...Object.fromEntries(params.env.map((e) => [e.name, e.value])) }
            : process.env as NodeJS.ProcessEnv,
        })
        this.terminals.set(terminalId, child)
        this.terminalOutputs.set(terminalId, [])
        this.terminalOutputBytes.set(terminalId, 0)
        const limit = params.outputByteLimit ?? MAX_TERMINAL_OUTPUT_BYTES
        const append = (chunk: Buffer): void => this.appendTerminalOutput(terminalId, chunk, limit)
        child.stdout?.on('data', append)
        child.stderr?.on('data', append)
        child.on('exit', (exitCode, signal) => {
          const status = { exitCode: exitCode ?? null, signal: signal ?? null }
          this.terminalExitStatuses.set(terminalId, status)
          const waiters = this.terminalWaiters.get(terminalId) ?? []
          for (const resolve of waiters) resolve(status)
          this.terminalWaiters.delete(terminalId)
        })
        return Promise.resolve({ terminalId })
      },
      terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
        const exitStatus = this.terminalExitStatuses.get(params.terminalId) ?? null
        const { output, truncated } = await this.readTerminalOutput(params.terminalId)
        return { output, truncated, exitStatus }
      },
      waitForTerminalExit: (params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => {
        const existing = this.terminalExitStatuses.get(params.terminalId)
        if (existing) return Promise.resolve(existing)
        return new Promise((resolve) => {
          const waiters = this.terminalWaiters.get(params.terminalId) ?? []
          waiters.push(resolve)
          this.terminalWaiters.set(params.terminalId, waiters)
        })
      },
      killTerminal: (params: KillTerminalRequest): Promise<KillTerminalResponse> => {
        const child = this.terminals.get(params.terminalId)
        if (child) {
          try { child.kill() } catch { /* ignore */ }
        }
        return Promise.resolve({})
      },
      releaseTerminal: (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
        const child = this.terminals.get(params.terminalId)
        if (child) {
          try { child.kill() } catch { /* ignore */ }
          this.terminals.delete(params.terminalId)
        }
        this.terminalOutputs.delete(params.terminalId)
        this.terminalOutputBytes.delete(params.terminalId)
        this.terminalExitStatuses.delete(params.terminalId)
        this.terminalWaiters.delete(params.terminalId)
        return Promise.resolve({})
      },
      extNotification: (_method: string, _params: Record<string, unknown>): Promise<void> => Promise.resolve(),
      extMethod: (_method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> => Promise.resolve({}),
    }
  }
}

export default AcpWorker
export { buildSpawnArgs }
export type { WorkerState, SessionUpdateCallback, AcpWorkerOptions, SessionSlot }
