import { Router } from 'express'
import type { Request, Response } from 'express'
import crypto from 'node:crypto'
import {
  toAcpPrompt,
  toAnthropicMessage,
  estimateInputTokensFromRequest,
  extractCwdFromRequest,
} from '../translator.js'
import type { AnthropicRequest, CollectedUpdate } from '../translator.js'
import { StreamingResponseBuilder, sendSseEvent } from '../sse.js'
import { computePrefixCacheKey } from '../prompt-cache.js'
import {
  renderToolCallStart,
  renderToolCallUpdate,
  renderPlan,
  type ToolCallState,
  type ToolCallStartLike,
  type ToolCallUpdateLike,
} from '../tool-renderer.js'
import { clientHasTodoWrite, planToTodos, buildRecap } from '../recap.js'
import { synthesizeToolUse, isEmulateEnabled } from '../tool-synth.js'
import type AcpPool from '../pool.js'
import type SessionManager from '../session-manager.js'
import type { Lease } from '../pool.js'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import logger, { responseLogger } from '../logger.js'
import { resolveKiroModelId } from '../kiro-models.js'

interface MessagesRouterOptions {
  readonly pool: AcpPool
  readonly sessionManager: SessionManager
}

const PING_INTERVAL_MS = 15_000
const STREAM_IDLE_TIMEOUT_MS = 30_000
const CHARS_PER_TOKEN = 4

const createAnthropicError = (type: string, message: string, status: number, res: Response): void => {
  res.status(status).json({
    type: 'error',
    error: { type, message },
  })
}

const validateRequest = (body: unknown): { valid: true; request: AnthropicRequest } | { valid: false; error: string } => {
  const req = body as Record<string, unknown>
  if (!req['model']) return { valid: false, error: 'model: field required' }
  if (!req['messages']) return { valid: false, error: 'messages: field required' }
  if (!Array.isArray(req['messages'])) return { valid: false, error: 'messages: must be an array' }
  if (req['max_tokens'] == null) return { valid: false, error: 'max_tokens: field required' }
  return { valid: true, request: body as AnthropicRequest }
}

/**
 * Wait until res can accept more writes (drain) or client disconnects.
 * Returns true if drained, false if connection ended.
 */
const awaitDrain = (res: Response): Promise<boolean> => {
  return new Promise((resolve) => {
    const onDrain = (): void => {
      res.off('close', onClose)
      resolve(true)
    }
    const onClose = (): void => {
      res.off('drain', onDrain)
      resolve(false)
    }
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

const handleNonStreaming = async (
  req: Request,
  res: Response,
  anthropicRequest: AnthropicRequest,
  pool: AcpPool,
  sessionManager: SessionManager,
): Promise<void> => {
  const proxySessionId = req.headers['x-claude-code-session-id'] as string | undefined
  const cwd = extractCwdFromRequest(anthropicRequest) ?? process.cwd()
  const cacheKey = computePrefixCacheKey(anthropicRequest)

  let lease: Lease
  let isExistingSession: boolean
  let cacheHit: { prefixHash: string; prefixTokens: number } | null
  try {
    const result = await sessionManager.acquireForSession(proxySessionId, cwd, cacheKey)
    lease = result.lease
    isExistingSession = result.isExistingSession
    cacheHit = result.cacheHit
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No workers available'
    logger.warn({ proxySessionId, err: message }, 'failed to acquire worker')
    createAnthropicError('overloaded_error', message, 529, res)
    return
  }
  try {
    const kiroModelId = resolveKiroModelId(anthropicRequest.model)
    const timings: Record<string, number> = {}
    const acpPrompt = toAcpPrompt(anthropicRequest, isExistingSession)
    const collected: CollectedUpdate[] = []
    const onUpdate = (update: SessionUpdate): void => {
      collected.push({ update })
    }
    const inputTokens = estimateInputTokensFromRequest(anthropicRequest)
    const promptStart = Date.now()
    const promptResponse = await lease.worker.prompt(lease.acpSessionId, acpPrompt, onUpdate, kiroModelId)
    timings.promptMs = Date.now() - promptStart
    const translateStart = Date.now()
    const response = toAnthropicMessage(collected, promptResponse, anthropicRequest, {
      inputTokens,
      cacheHit: cacheHit ? { prefixTokens: cacheHit.prefixTokens } : null,
      baseDir: cwd,
    })
    timings.translateMs = Date.now() - translateStart
    logger.info({
      workerId: lease.worker.id,
      acpSessionId: lease.acpSessionId,
      timings,
      model: kiroModelId,
      cacheHit: !!cacheHit,
      cacheReadTokens: cacheHit?.prefixTokens ?? 0,
    }, 'non-streaming complete')
    if (responseLogger.level === 'info' || responseLogger.level === 'debug' || responseLogger.level === 'trace') {
      responseLogger.info({ direction: 'request', model: anthropicRequest.model, sessionId: proxySessionId, messages: anthropicRequest.messages, system: anthropicRequest.system }, 'claude-code → proxy')
      responseLogger.info({ direction: 'response', model: anthropicRequest.model, sessionId: proxySessionId, response }, 'proxy → claude-code')
    }
    res.json(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    logger.error({ err, method: req.method, path: req.originalUrl }, `non-streaming error: ${message}`)
    createAnthropicError('api_error', message, 500, res)
  } finally {
    sessionManager.releaseLease(lease)
  }
}

const handleStreaming = async (
  req: Request,
  res: Response,
  anthropicRequest: AnthropicRequest,
  pool: AcpPool,
  sessionManager: SessionManager,
): Promise<void> => {
  const proxySessionId = req.headers['x-claude-code-session-id'] as string | undefined
  const cwd = extractCwdFromRequest(anthropicRequest) ?? process.cwd()
  const cacheKey = computePrefixCacheKey(anthropicRequest)

  let lease: Lease
  let isExistingSession: boolean
  let cacheHit: { prefixHash: string; prefixTokens: number } | null
  try {
    const result = await sessionManager.acquireForSession(proxySessionId, cwd, cacheKey)
    lease = result.lease
    isExistingSession = result.isExistingSession
    cacheHit = result.cacheHit
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No workers available'
    logger.warn({ proxySessionId, err: message }, 'failed to acquire worker for streaming')
    createAnthropicError('overloaded_error', message, 529, res)
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, '')}`
  const builder = new StreamingResponseBuilder()
  let outputCharCount = 0
  let currentTextBlockIndex: number | null = null
  let currentThinkingBlockIndex: number | null = null
  let isClientDisconnected = false
  let acpInputTokens: number | null = null
  let lastChunkAt = Date.now()
  // Tool calls get their own dedicated text blocks, tracked by toolCallId.
  const toolCalls: Map<string, ToolCallState> = new Map()
  // Side state for tool_use synthesis (EMULATE_CC_TOOLS).
  const emulate = isEmulateEnabled()
  // toolCallId → {blockIndex of open tool_use block, last input JSON string}
  const synthBlocks: Map<string, { blockIndex: number; lastJson: string; toolUseId: string; name: string }> = new Map()
  // Plan: if client has TodoWrite, synthesize tool_use; else markdown block.
  const useTodoWriteSynthesis = clientHasTodoWrite(anthropicRequest.tools)
  let planBlockIndex: number | null = null
  let planRendered = ''
  let planToolUseId: string | null = null
  let planToolUseBlockIndex: number | null = null
  let lastPlanInputJson = ''
  let hasPlanUpdate = false
  builder.sendMessageStart(res, messageId, anthropicRequest.model)
  const pingTimer = setInterval(() => {
    if (!isClientDisconnected) builder.sendPing(res)
  }, PING_INTERVAL_MS)
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  const armStallTimer = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      if (!isClientDisconnected && Date.now() - lastChunkAt >= STREAM_IDLE_TIMEOUT_MS) {
        logger.warn({ workerId: lease.worker.id, idleMs: Date.now() - lastChunkAt }, 'stream idle timeout — aborting')
        lease.worker.cancel(lease.acpSessionId).catch(() => {})
      }
    }, STREAM_IDLE_TIMEOUT_MS)
  }
  armStallTimer()
  const handleDisconnect = (): void => {
    isClientDisconnected = true
    clearInterval(pingTimer)
    if (stallTimer) clearTimeout(stallTimer)
    lease.worker.cancel(lease.acpSessionId).catch(() => {})
  }
  req.on('close', handleDisconnect)

  /**
   * Push to res honoring backpressure. Returns false if connection ended.
   */
  const safeWrite = async (write: () => void): Promise<boolean> => {
    if (isClientDisconnected) return false
    write()
    if (res.writableNeedDrain) {
      const drained = await awaitDrain(res)
      if (!drained) return false
    }
    return true
  }

  /**
   * onUpdate is called synchronously by the ACP SDK. To apply backpressure
   * without backing up the worker, we serialize updates into a queue that is
   * drained by an async worker promise.
   */
  const updateQueue: SessionUpdate[] = []
  let queueResolve: (() => void) | null = null
  const onUpdate = (update: SessionUpdate): void => {
    if (isClientDisconnected) return
    lastChunkAt = Date.now()
    armStallTimer()
    updateQueue.push(update)
    if (queueResolve) {
      const r = queueResolve
      queueResolve = null
      r()
    }
  }
  const waitForUpdate = (): Promise<void> => new Promise((resolve) => { queueResolve = resolve })

  let promptDone = false
  const drainUpdates = async (): Promise<void> => {
    while (!isClientDisconnected) {
      if (updateQueue.length === 0) {
        if (promptDone) return
        await waitForUpdate()
        continue
      }
      const update = updateQueue.shift()!
      await applyUpdate(update)
    }
  }

  /**
   * Emit (or refresh) a synthesized Anthropic tool_use block for an ACP
   * tool_call. Only fires when EMULATE_CC_TOOLS is enabled. Names are
   * `kiro_*` prefixed so CC won't try to execute them — input shape matches
   * CC's canonical tool schemas for forward-compatibility.
   */
  const emitSynthForCall = async (call: ToolCallStartLike | ToolCallUpdateLike): Promise<void> => {
    if (!emulate) return
    const prev = synthBlocks.get(call.toolCallId)
    const synth = synthesizeToolUse(call as ToolCallStartLike, prev?.toolUseId ?? `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`)
    if (!synth) return
    const json = JSON.stringify(synth.input)
    if (prev && prev.lastJson === json) return
    if (prev) {
      // Anthropic tool_use input is immutable once block_stop fires. Close prior, open new.
      await safeWrite(() => builder.sendContentBlockStop(res, prev.blockIndex))
    }
    const newToolUseId = prev?.toolUseId ?? synth.toolUseId
    const blockIndex = builder.incrementBlockIndex()
    await safeWrite(() => builder.sendToolUseStart(res, blockIndex, newToolUseId, synth.name))
    if (json !== '{}') {
      await safeWrite(() => builder.sendToolUseDelta(res, blockIndex, json))
      outputCharCount += json.length
    }
    synthBlocks.set(call.toolCallId, { blockIndex, lastJson: json, toolUseId: newToolUseId, name: synth.name })
  }

  const applyUpdate = async (update: SessionUpdate): Promise<void> => {
    if (update.sessionUpdate === 'agent_thought_chunk') {
      const thought = (update.content as { thought?: string }).thought ?? ''
      if (thought.length === 0) return
      if (currentTextBlockIndex !== null) {
        await safeWrite(() => builder.sendContentBlockStop(res, currentTextBlockIndex!))
        currentTextBlockIndex = null
      }
      if (currentThinkingBlockIndex === null) {
        currentThinkingBlockIndex = builder.incrementBlockIndex()
        await safeWrite(() => builder.sendContentBlockStart(res, currentThinkingBlockIndex!, { type: 'thinking', thinking: '' }))
      }
      await safeWrite(() => builder.sendThinkingDelta(res, currentThinkingBlockIndex!, thought))
      return
    }
    if (update.sessionUpdate === 'agent_message_chunk') {
      const block = update.content
      if (block.type === 'text' && block.text.length > 0) {
        if (currentThinkingBlockIndex !== null) {
          await safeWrite(() => builder.sendSignatureDelta(res, currentThinkingBlockIndex!, ''))
          await safeWrite(() => builder.sendContentBlockStop(res, currentThinkingBlockIndex!))
          currentThinkingBlockIndex = null
        }
        if (currentTextBlockIndex === null) {
          currentTextBlockIndex = builder.incrementBlockIndex()
          await safeWrite(() => builder.sendContentBlockStart(res, currentTextBlockIndex!, { type: 'text', text: '' }))
        }
        await safeWrite(() => builder.sendTextDelta(res, currentTextBlockIndex!, block.text))
        outputCharCount += block.text.length
      }
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      const call = update as unknown as ToolCallStartLike
      // Close any open text/thinking block; tool call gets its own blocks.
      if (currentThinkingBlockIndex !== null) {
        await safeWrite(() => builder.sendSignatureDelta(res, currentThinkingBlockIndex!, ''))
        await safeWrite(() => builder.sendContentBlockStop(res, currentThinkingBlockIndex!))
        currentThinkingBlockIndex = null
      }
      if (currentTextBlockIndex !== null) {
        await safeWrite(() => builder.sendContentBlockStop(res, currentTextBlockIndex!))
        currentTextBlockIndex = null
      }
      const rendered = renderToolCallStart(call, cwd)
      const blockIndex = builder.incrementBlockIndex()
      await safeWrite(() => builder.sendContentBlockStart(res, blockIndex, { type: 'text', text: '' }))
      await safeWrite(() => builder.sendTextDelta(res, blockIndex, rendered))
      outputCharCount += rendered.length
      toolCalls.set(call.toolCallId, {
        toolCallId: call.toolCallId,
        blockIndex,
        rendered,
        status: call.status ?? 'pending',
      })
      await emitSynthForCall(call)
      return
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const upd = update as unknown as ToolCallUpdateLike
      const prev = toolCalls.get(upd.toolCallId)
      if (!prev || prev.blockIndex === null) {
        // Update before start (rare). Synthesize a fresh start.
        if (currentTextBlockIndex !== null) {
          await safeWrite(() => builder.sendContentBlockStop(res, currentTextBlockIndex!))
          currentTextBlockIndex = null
        }
        const rendered = renderToolCallStart(upd, cwd)
        const blockIndex = builder.incrementBlockIndex()
        await safeWrite(() => builder.sendContentBlockStart(res, blockIndex, { type: 'text', text: '' }))
        await safeWrite(() => builder.sendTextDelta(res, blockIndex, rendered))
        outputCharCount += rendered.length
        toolCalls.set(upd.toolCallId, {
          toolCallId: upd.toolCallId,
          blockIndex,
          rendered,
          status: upd.status ?? 'pending',
        })
        await emitSynthForCall(upd)
        return
      }
      const { delta, rendered, status } = renderToolCallUpdate(prev, upd, cwd)
      if (delta.length > 0) {
        await safeWrite(() => builder.sendTextDelta(res, prev.blockIndex!, delta))
        outputCharCount += delta.length
      }
      prev.rendered = rendered
      prev.status = status
      await emitSynthForCall(upd)
      return
    }
    if (update.sessionUpdate === 'plan') {
      const entries = (update as unknown as { entries: Array<{ content: string; status: string; priority?: string }> }).entries ?? []
      if (entries.length === 0) return
      hasPlanUpdate = true
      // Close any open text/thinking block; plan gets its own.
      if (currentThinkingBlockIndex !== null) {
        await safeWrite(() => builder.sendSignatureDelta(res, currentThinkingBlockIndex!, ''))
        await safeWrite(() => builder.sendContentBlockStop(res, currentThinkingBlockIndex!))
        currentThinkingBlockIndex = null
      }
      if (currentTextBlockIndex !== null) {
        await safeWrite(() => builder.sendContentBlockStop(res, currentTextBlockIndex!))
        currentTextBlockIndex = null
      }

      if (useTodoWriteSynthesis) {
        // Emit a real Anthropic tool_use block so CC renders the TodoWrite widget.
        const input = planToTodos(entries)
        const fullJson = JSON.stringify(input)
        if (planToolUseBlockIndex === null) {
          planToolUseId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
          planToolUseBlockIndex = builder.incrementBlockIndex()
          await safeWrite(() => builder.sendToolUseStart(res, planToolUseBlockIndex!, planToolUseId!, 'TodoWrite'))
          await safeWrite(() => builder.sendToolUseDelta(res, planToolUseBlockIndex!, fullJson))
          lastPlanInputJson = fullJson
          outputCharCount += fullJson.length
          return
        }
        // Subsequent plan update: stop previous block, open a new tool_use
        // (tool_use input is immutable once stop is sent — Anthropic spec).
        if (fullJson === lastPlanInputJson) return
        await safeWrite(() => builder.sendContentBlockStop(res, planToolUseBlockIndex!))
        planToolUseId = `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
        planToolUseBlockIndex = builder.incrementBlockIndex()
        await safeWrite(() => builder.sendToolUseStart(res, planToolUseBlockIndex!, planToolUseId!, 'TodoWrite'))
        await safeWrite(() => builder.sendToolUseDelta(res, planToolUseBlockIndex!, fullJson))
        lastPlanInputJson = fullJson
        outputCharCount += fullJson.length
        return
      }

      // Fallback: markdown checklist in a text block.
      const planText = renderPlan(entries)
      if (planText.length === 0) return
      if (planBlockIndex === null) {
        planBlockIndex = builder.incrementBlockIndex()
        await safeWrite(() => builder.sendContentBlockStart(res, planBlockIndex!, { type: 'text', text: '' }))
        await safeWrite(() => builder.sendTextDelta(res, planBlockIndex!, planText))
        planRendered = planText
        outputCharCount += planText.length
        return
      }
      if (planText.startsWith(planRendered)) {
        const delta = planText.slice(planRendered.length)
        if (delta.length > 0) {
          await safeWrite(() => builder.sendTextDelta(res, planBlockIndex!, delta))
          outputCharCount += delta.length
        }
      } else {
        const sep = '\n---\n'
        await safeWrite(() => builder.sendTextDelta(res, planBlockIndex!, sep + planText))
        outputCharCount += sep.length + planText.length
      }
      planRendered = planText
      return
    }
    if (update.sessionUpdate === 'usage_update') {
      const usage = update as unknown as { used: number; size: number }
      acpInputTokens = usage.used
    }
  }

  try {
    const kiroModelId = resolveKiroModelId(anthropicRequest.model)
    const timings: Record<string, number> = {}
    const acpPrompt = toAcpPrompt(anthropicRequest, isExistingSession)
    const promptStart = Date.now()
    const drainTask = drainUpdates()
    const promptTask = lease.worker.prompt(lease.acpSessionId, acpPrompt, onUpdate, kiroModelId)
      .finally(() => {
        promptDone = true
        if (queueResolve) {
          const r = queueResolve
          queueResolve = null
          r()
        }
      })
    const promptResponse = await promptTask
    await drainTask
    timings.promptMs = Date.now() - promptStart
    logger.info({
      workerId: lease.worker.id,
      acpSessionId: lease.acpSessionId,
      timings,
      model: kiroModelId,
      cacheHit: !!cacheHit,
      cacheReadTokens: cacheHit?.prefixTokens ?? 0,
    }, 'streaming complete')
    if (!isClientDisconnected) {
      if (currentThinkingBlockIndex !== null) {
        await safeWrite(() => builder.sendSignatureDelta(res, currentThinkingBlockIndex!, ''))
        await safeWrite(() => builder.sendContentBlockStop(res, currentThinkingBlockIndex!))
      }
      if (currentTextBlockIndex !== null) {
        await safeWrite(() => builder.sendContentBlockStop(res, currentTextBlockIndex!))
      }
      if (planBlockIndex !== null) {
        await safeWrite(() => builder.sendContentBlockStop(res, planBlockIndex!))
      }
      if (planToolUseBlockIndex !== null) {
        await safeWrite(() => builder.sendContentBlockStop(res, planToolUseBlockIndex!))
      }
      // Close any still-open synthesized tool_use blocks.
      for (const synth of synthBlocks.values()) {
        await safeWrite(() => builder.sendContentBlockStop(res, synth.blockIndex))
      }
      // Append deterministic "What changed" recap when there was tool activity.
      if (toolCalls.size > 0 || hasPlanUpdate) {
        const recap = buildRecap(toolCalls, hasPlanUpdate, { baseDir: cwd })
        if (recap.length > 0) {
          const recapIndex = builder.incrementBlockIndex()
          await safeWrite(() => builder.sendContentBlockStart(res, recapIndex, { type: 'text', text: '' }))
          await safeWrite(() => builder.sendTextDelta(res, recapIndex, recap))
          await safeWrite(() => builder.sendContentBlockStop(res, recapIndex))
          outputCharCount += recap.length
        }
      }
      const hasContent = currentTextBlockIndex !== null || currentThinkingBlockIndex !== null ||
        planBlockIndex !== null || planToolUseBlockIndex !== null || toolCalls.size > 0
      if (!hasContent) {
        const emptyIndex = builder.incrementBlockIndex()
        await safeWrite(() => builder.sendContentBlockStart(res, emptyIndex, { type: 'text', text: '' }))
        await safeWrite(() => builder.sendTextDelta(res, emptyIndex, '[No response from model]'))
        await safeWrite(() => builder.sendContentBlockStop(res, emptyIndex))
      }
      const stopReason = promptResponse.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn'
      const cacheReadTokens = cacheHit?.prefixTokens ?? 0
      const totalInputTokens = acpInputTokens ?? estimateInputTokensFromRequest(anthropicRequest)
      builder.sendMessageDelta(res, stopReason, {
        input_tokens: Math.max(0, totalInputTokens - cacheReadTokens),
        output_tokens: Math.ceil(outputCharCount / CHARS_PER_TOKEN),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheReadTokens,
      })
      builder.sendMessageStop(res)
      res.end()
    }
  } catch (err) {
    if (!isClientDisconnected) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      logger.error({ err, method: req.method, path: req.originalUrl }, `streaming error: ${message}`)
      if (currentThinkingBlockIndex !== null) {
        await safeWrite(() => builder.sendSignatureDelta(res, currentThinkingBlockIndex!, ''))
        await safeWrite(() => builder.sendContentBlockStop(res, currentThinkingBlockIndex!))
      }
      if (currentTextBlockIndex !== null) {
        await safeWrite(() => builder.sendContentBlockStop(res, currentTextBlockIndex!))
      }
      sendSseEvent(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message },
      })
      res.end()
    }
  } finally {
    clearInterval(pingTimer)
    if (stallTimer) clearTimeout(stallTimer)
    req.off('close', handleDisconnect)
    sessionManager.releaseLease(lease)
  }
}

const createMessagesRouter = ({ pool, sessionManager }: MessagesRouterOptions): Router => {
  const router = Router()
  router.post('/v1/messages', async (req: Request, res: Response): Promise<void> => {
    const validation = validateRequest(req.body)
    if (!validation.valid) {
      createAnthropicError('invalid_request_error', validation.error, 400, res)
      return
    }
    const anthropicRequest = validation.request
    if (anthropicRequest.stream) {
      await handleStreaming(req, res, anthropicRequest, pool, sessionManager)
    } else {
      await handleNonStreaming(req, res, anthropicRequest, pool, sessionManager)
    }
  })
  return router
}

export default createMessagesRouter
export type { MessagesRouterOptions }
