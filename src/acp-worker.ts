import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as fs from 'node:fs/promises'
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

type WorkerState = 'idle' | 'busy' | 'dead'

type SessionUpdateCallback = (update: SessionUpdate) => void

interface AcpWorkerOptions {
  readonly id: number
  readonly kiroCli: string
  readonly cwd: string
}

const MAX_TERMINAL_OUTPUT_BYTES = 512_000 // 512 KB default cap per terminal

/** Build kiro-cli acp spawn args from environment configuration. */
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
  private cwd: string
  private process: ChildProcess | null = null
  private connection: acp.ClientSideConnection | null = null
  private sessionId: string | null = null
  private onUpdate: SessionUpdateCallback | null = null
  private state: WorkerState = 'idle'
  private currentModelId: string | null = null
  private terminals: Map<string, ChildProcess> = new Map()
  private terminalOutputs: Map<string, string> = new Map()
  private terminalExitStatuses: Map<string, { exitCode: number | null; signal: string | null }> = new Map()
  private terminalWaiters: Map<string, Array<(status: { exitCode: number | null; signal: string | null }) => void>> = new Map()
  private nextTerminalId = 0

  constructor(options: AcpWorkerOptions) {
    this.id = options.id
    this.kiroCli = options.kiroCli
    this.cwd = options.cwd
  }

  getState(): WorkerState {
    return this.state
  }

  setState(state: WorkerState): void {
    this.state = state
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  async init(): Promise<void> {
    const args = buildSpawnArgs()
    console.log(`[worker-${this.id}] spawning: ${this.kiroCli} ${args.join(' ')}`)
    const child = spawn(this.kiroCli, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
    })
    this.process = child
    child.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[worker-${this.id}] ${chunk.toString().trimEnd()}`)
    })
    child.on('exit', (code, signal) => {
      console.error(`[worker-${this.id}] process exited (code=${code}, signal=${signal})`)
      this.state = 'dead'
      this.connection = null
      this.sessionId = null
    })
    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>
    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    const stream = acp.ndJsonStream(output, input)
    const client = this.createClient()
    this.connection = new acp.ClientSideConnection((_agent) => client, stream)
    const initResult = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    })
    console.log(`[worker-${this.id}] initialized (protocol v${initResult.protocolVersion})`)
    const sessionResult = await this.connection.newSession({
      cwd: this.cwd,
      mcpServers: [],
    })
    this.sessionId = sessionResult.sessionId
    console.log(`[worker-${this.id}] session created: ${this.sessionId}`)
  }

  getCwd(): string {
    return this.cwd
  }

  /** Create a new ACP session with a different working directory. */
  async setCwd(newCwd: string): Promise<void> {
    if (!this.connection) {
      throw new Error(`Worker ${this.id} is not initialized`)
    }
    if (newCwd === this.cwd) return
    console.log(`[worker-${this.id}] switching cwd: ${this.cwd} → ${newCwd}`)
    const sessionResult = await this.connection.newSession({
      cwd: newCwd,
      mcpServers: [],
    })
    this.cwd = newCwd
    this.sessionId = sessionResult.sessionId
    this.currentModelId = null
    console.log(`[worker-${this.id}] new session for cwd: ${this.sessionId}`)
  }

  async prompt(
    content: Array<ContentBlock>,
    onUpdate?: SessionUpdateCallback,
    modelId?: string,
  ): Promise<PromptResponse> {
    if (!this.connection || !this.sessionId) {
      throw new Error(`Worker ${this.id} is not initialized`)
    }
    if (this.state === 'dead') {
      throw new Error(`Worker ${this.id} is dead`)
    }
    this.state = 'busy'
    this.onUpdate = onUpdate ?? null
    try {
      if (modelId && modelId !== this.currentModelId) {
        try {
          await this.connection.unstable_setSessionModel({
            sessionId: this.sessionId,
            modelId,
          })
          this.currentModelId = modelId
          console.log(`[worker-${this.id}] model set to: ${modelId}`)
        } catch (err) {
          console.warn(`[worker-${this.id}] setSessionModel failed: ${err}`)
        }
      }
      const result = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: content,
      })
      return result
    } finally {
      this.onUpdate = null
      this.cleanupCompletedTerminals()
      if (this.state === 'busy') {
        this.state = 'idle'
      }
    }
  }

  /** Remove terminal state for processes that have exited. */
  private cleanupCompletedTerminals(): void {
    for (const [terminalId, status] of this.terminalExitStatuses) {
      if (status.exitCode !== null || status.signal !== null) {
        this.terminals.delete(terminalId)
        this.terminalOutputs.delete(terminalId)
        this.terminalExitStatuses.delete(terminalId)
        this.terminalWaiters.delete(terminalId)
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId) return
    await this.connection.cancel({ sessionId: this.sessionId })
  }

  kill(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    this.state = 'dead'
    this.connection = null
    this.sessionId = null
    this.currentModelId = null
    for (const [, proc] of this.terminals) {
      proc.kill()
    }
    this.terminals.clear()
    this.terminalOutputs.clear()
    this.terminalExitStatuses.clear()
    this.terminalWaiters.clear()
  }

  private createClient(): acp.Client {
    return {
      requestPermission: (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const allowOption = params.options.find((o) => o.kind === 'allow_once')
          ?? params.options.find((o) => o.kind === 'allow_always')
          ?? params.options[0]
        console.log(`[worker-${this.id}] auto-approving permission: ${params.toolCall.title} → ${allowOption?.name}`)
        return Promise.resolve({
          outcome: {
            outcome: 'selected',
            optionId: allowOption!.optionId,
          },
        })
      },
      sessionUpdate: (params: SessionNotification): Promise<void> => {
        if (this.onUpdate) {
          this.onUpdate(params.update)
        }
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
        const child = spawn(params.command, params.args ?? [], {
          cwd: params.cwd ?? this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: params.env
            ? { ...process.env, ...Object.fromEntries(params.env.map((e) => [e.name, e.value])) }
            : process.env as NodeJS.ProcessEnv,
        })
        this.terminals.set(terminalId, child)
        this.terminalOutputs.set(terminalId, '')
        const appendOutput = (chunk: Buffer): void => {
          const current = this.terminalOutputs.get(terminalId) ?? ''
          const limit = params.outputByteLimit ?? MAX_TERMINAL_OUTPUT_BYTES
          let updated = current + chunk.toString()
          if (Buffer.byteLength(updated) > limit) {
            updated = updated.slice(-limit)
          }
          this.terminalOutputs.set(terminalId, updated)
        }
        child.stdout?.on('data', appendOutput)
        child.stderr?.on('data', appendOutput)
        child.on('exit', (exitCode, signal) => {
          const status = { exitCode: exitCode ?? null, signal: signal ?? null }
          this.terminalExitStatuses.set(terminalId, status)
          const waiters = this.terminalWaiters.get(terminalId) ?? []
          for (const resolve of waiters) {
            resolve(status)
          }
          this.terminalWaiters.delete(terminalId)
        })
        return Promise.resolve({ terminalId })
      },
      terminalOutput: (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
        const output = this.terminalOutputs.get(params.terminalId) ?? ''
        const exitStatus = this.terminalExitStatuses.get(params.terminalId) ?? null
        return Promise.resolve({
          output,
          truncated: false,
          exitStatus,
        })
      },
      waitForTerminalExit: (params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => {
        const existing = this.terminalExitStatuses.get(params.terminalId)
        if (existing) {
          return Promise.resolve(existing)
        }
        return new Promise((resolve) => {
          const waiters = this.terminalWaiters.get(params.terminalId) ?? []
          waiters.push(resolve)
          this.terminalWaiters.set(params.terminalId, waiters)
        })
      },
      killTerminal: (params: KillTerminalRequest): Promise<KillTerminalResponse> => {
        const child = this.terminals.get(params.terminalId)
        if (child) {
          child.kill()
        }
        return Promise.resolve({})
      },
      releaseTerminal: (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
        const child = this.terminals.get(params.terminalId)
        if (child) {
          child.kill()
          this.terminals.delete(params.terminalId)
        }
        this.terminalOutputs.delete(params.terminalId)
        this.terminalExitStatuses.delete(params.terminalId)
        this.terminalWaiters.delete(params.terminalId)
        return Promise.resolve({})
      },
      // Silently absorb Kiro-specific extension notifications (_kiro.dev/*)
      // so the ACP SDK does not emit "Method not found" errors for them.
      extNotification: (_method: string, _params: Record<string, unknown>): Promise<void> => {
        return Promise.resolve()
      },
      extMethod: (_method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        return Promise.resolve({})
      },
    }
  }
}

export default AcpWorker
export { buildSpawnArgs }
export type { WorkerState, SessionUpdateCallback, AcpWorkerOptions }
