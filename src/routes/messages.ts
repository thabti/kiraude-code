import { Router } from 'express'
import type { Request, Response } from 'express'
import crypto from 'node:crypto'
import { toAcpPrompt, toAnthropicMessage, estimateTokens, extractCwdFromRequest } from '../translator.js'
import type { AnthropicRequest, CollectedUpdate } from '../translator.js'
import { StreamingResponseBuilder, sendSseEvent } from '../sse.js'
import type AcpPool from '../pool.js'
import type AcpWorker from '../acp-worker.js'
import type SessionManager from '../session-manager.js'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import logger from '../logger.js'
import { resolveKiroModelId } from '../kiro-models.js'

interface MessagesRouterOptions {
  readonly pool: AcpPool
  readonly sessionManager: SessionManager
}

const PING_INTERVAL_MS = 15_000
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

const estimateInputTokens = (request: AnthropicRequest): number => {
  let inputText = ''
  for (const msg of request.messages) {
    if (typeof msg.content === 'string') {
      inputText += msg.content
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') inputText += block.text
      }
    }
  }
  if (request.system) {
    inputText += typeof request.system === 'string'
      ? request.system
      : request.system.map((b) => b.text).join('\n')
  }
  return estimateTokens(inputText)
}

const handleNonStreaming = async (req: Request, res: Response, anthropicRequest: AnthropicRequest, pool: AcpPool, sessionManager: SessionManager): Promise<void> => {
  const sessionId = req.headers['x-claude-code-session-id'] as string | undefined
  let worker: AcpWorker
  let isExistingSession: boolean
  try {
    const result = await sessionManager.acquireForSession(sessionId)
    worker = result.worker
    isExistingSession = result.isExistingSession
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No workers available'
    logger.warn({ sessionId, err: message }, 'failed to acquire worker')
    createAnthropicError('overloaded_error', message, 529, res)
    return
  }
  try {
    const kiroModelId = resolveKiroModelId(anthropicRequest.model)
    const requestCwd = extractCwdFromRequest(anthropicRequest)
    if (requestCwd && requestCwd !== worker.getCwd()) {
      await worker.setCwd(requestCwd)
    }
    const acpPrompt = toAcpPrompt(anthropicRequest, isExistingSession)
    const collected: CollectedUpdate[] = []
    const onUpdate = (update: SessionUpdate): void => {
      collected.push({ update })
    }
    const promptResponse = await worker.prompt(acpPrompt, onUpdate, kiroModelId)
    const response = toAnthropicMessage(collected, promptResponse, anthropicRequest)
    res.json(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    logger.error({ err, method: req.method, path: req.originalUrl }, `non-streaming error: ${message}`)
    createAnthropicError('api_error', message, 500, res)
  } finally {
    sessionManager.releaseWorker(sessionId, worker)
  }
}

const handleStreaming = async (req: Request, res: Response, anthropicRequest: AnthropicRequest, pool: AcpPool, sessionManager: SessionManager): Promise<void> => {
  const sessionId = req.headers['x-claude-code-session-id'] as string | undefined
  let worker: AcpWorker
  let isExistingSession: boolean
  try {
    const result = await sessionManager.acquireForSession(sessionId)
    worker = result.worker
    isExistingSession = result.isExistingSession
  } catch (err) {
    const message = err instanceof Error ? err.message : 'No workers available'
    logger.warn({ sessionId, err: message }, 'failed to acquire worker for streaming')
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
  let outputTokenCount = 0
  let currentTextBlockIndex: number | null = null
  let currentThinkingBlockIndex: number | null = null
  let hasEmittedToolUse = false
  let isClientDisconnected = false
  let acpInputTokens: number | null = null
  let acpOutputTokens: number | null = null
  builder.sendMessageStart(res, messageId, anthropicRequest.model)
  const pingTimer = setInterval(() => {
    if (!isClientDisconnected) {
      builder.sendPing(res)
    }
  }, PING_INTERVAL_MS)
  const handleDisconnect = (): void => {
    isClientDisconnected = true
    clearInterval(pingTimer)
    worker.cancel().catch(() => {})
  }
  req.on('close', handleDisconnect)
  const toolBlockIndices: Map<string, number> = new Map()
  try {
    const kiroModelId = resolveKiroModelId(anthropicRequest.model)
    const requestCwd = extractCwdFromRequest(anthropicRequest)
    if (requestCwd && requestCwd !== worker.getCwd()) {
      await worker.setCwd(requestCwd)
    }
    const acpPrompt = toAcpPrompt(anthropicRequest, isExistingSession)
    const onUpdate = (update: SessionUpdate): void => {
      if (isClientDisconnected) return

      if (update.sessionUpdate === 'agent_thought_chunk') {
        const thought = (update.content as { thought?: string }).thought ?? ''
        if (thought.length === 0) return
        if (currentTextBlockIndex !== null) {
          builder.sendContentBlockStop(res, currentTextBlockIndex)
          currentTextBlockIndex = null
        }
        if (currentThinkingBlockIndex === null) {
          currentThinkingBlockIndex = builder.incrementBlockIndex()
          builder.sendContentBlockStart(res, currentThinkingBlockIndex, { type: 'thinking', thinking: '' })
        }
        builder.sendThinkingDelta(res, currentThinkingBlockIndex, thought)
      }

      if (update.sessionUpdate === 'agent_message_chunk') {
        const block = update.content
        if (block.type === 'text' && block.text.length > 0) {
          if (currentThinkingBlockIndex !== null) {
            builder.sendSignatureDelta(res, currentThinkingBlockIndex, '')
            builder.sendContentBlockStop(res, currentThinkingBlockIndex)
            currentThinkingBlockIndex = null
          }
          if (currentTextBlockIndex === null) {
            currentTextBlockIndex = builder.incrementBlockIndex()
            builder.sendContentBlockStart(res, currentTextBlockIndex, { type: 'text', text: '' })
          }
          builder.sendTextDelta(res, currentTextBlockIndex, block.text)
          outputTokenCount += block.text.length
        }
      }

      if (update.sessionUpdate === 'tool_call') {
        if (currentThinkingBlockIndex !== null) {
          builder.sendSignatureDelta(res, currentThinkingBlockIndex, '')
          builder.sendContentBlockStop(res, currentThinkingBlockIndex)
          currentThinkingBlockIndex = null
        }
        if (currentTextBlockIndex !== null) {
          builder.sendContentBlockStop(res, currentTextBlockIndex)
          currentTextBlockIndex = null
        }
        const index = builder.incrementBlockIndex()
        toolBlockIndices.set(update.toolCallId, index)
        hasEmittedToolUse = true
        builder.sendContentBlockStart(res, index, {
          type: 'tool_use',
          id: update.toolCallId,
          name: update.title,
          input: {},
        })
        if (update.rawInput !== undefined) {
          builder.sendToolUseDelta(res, index, JSON.stringify(update.rawInput))
        }
      }

      if (update.sessionUpdate === 'tool_call_update') {
        const index = toolBlockIndices.get(update.toolCallId)
        if (index !== undefined) {
          if (update.rawInput !== undefined) {
            builder.sendToolUseDelta(res, index, JSON.stringify(update.rawInput))
          }
          if (update.status === 'completed' || update.status === 'failed') {
            builder.sendContentBlockStop(res, index)
            toolBlockIndices.delete(update.toolCallId)
          }
        }
      }

      if (update.sessionUpdate === 'plan') {
        const entries = (update as unknown as { entries: Array<{ content: string; status: string }> }).entries
        if (entries && entries.length > 0) {
          const statusIcon: Record<string, string> = { completed: '✅', in_progress: '🔄', pending: '⬚' }
          const planText = entries.map((e) => `${statusIcon[e.status] ?? '⬚'} ${e.content}`).join('\n')
          if (currentThinkingBlockIndex !== null) {
            builder.sendSignatureDelta(res, currentThinkingBlockIndex, '')
            builder.sendContentBlockStop(res, currentThinkingBlockIndex)
            currentThinkingBlockIndex = null
          }
          if (currentTextBlockIndex === null) {
            currentTextBlockIndex = builder.incrementBlockIndex()
            builder.sendContentBlockStart(res, currentTextBlockIndex, { type: 'text', text: '' })
          }
          builder.sendTextDelta(res, currentTextBlockIndex, `\n${planText}\n`)
          outputTokenCount += planText.length
        }
      }

      if (update.sessionUpdate === 'usage_update') {
        const usage = update as unknown as { used: number; size: number }
        acpInputTokens = usage.used
        acpOutputTokens = Math.ceil(outputTokenCount / CHARS_PER_TOKEN)
      }
    }
    const promptResponse = await worker.prompt(acpPrompt, onUpdate, kiroModelId)
    if (!isClientDisconnected) {
      if (currentThinkingBlockIndex !== null) {
        builder.sendSignatureDelta(res, currentThinkingBlockIndex, '')
        builder.sendContentBlockStop(res, currentThinkingBlockIndex)
      }
      if (currentTextBlockIndex !== null) {
        builder.sendContentBlockStop(res, currentTextBlockIndex)
      }
      for (const [, index] of toolBlockIndices) {
        builder.sendContentBlockStop(res, index)
      }
      const hasContent = currentTextBlockIndex !== null || currentThinkingBlockIndex !== null || hasEmittedToolUse
      if (!hasContent) {
        const emptyIndex = builder.incrementBlockIndex()
        builder.sendContentBlockStart(res, emptyIndex, { type: 'text', text: '' })
        builder.sendTextDelta(res, emptyIndex, '[No response from model]')
        builder.sendContentBlockStop(res, emptyIndex)
      }
      const stopReason = hasEmittedToolUse
        ? 'tool_use'
        : (promptResponse.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn')
      builder.sendMessageDelta(res, stopReason, {
        input_tokens: acpInputTokens ?? estimateInputTokens(anthropicRequest),
        output_tokens: acpOutputTokens ?? Math.ceil(outputTokenCount / CHARS_PER_TOKEN),
      })
      builder.sendMessageStop(res)
      res.end()
    }
  } catch (err) {
    if (!isClientDisconnected) {
      const message = err instanceof Error ? err.message : 'Internal server error'
      logger.error({ err, method: req.method, path: req.originalUrl }, `streaming error: ${message}`)
      if (currentThinkingBlockIndex !== null) {
        builder.sendSignatureDelta(res, currentThinkingBlockIndex, '')
        builder.sendContentBlockStop(res, currentThinkingBlockIndex)
      }
      if (currentTextBlockIndex !== null) {
        builder.sendContentBlockStop(res, currentTextBlockIndex)
      }
      for (const [, index] of toolBlockIndices) {
        builder.sendContentBlockStop(res, index)
      }
      sendSseEvent(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message },
      })
      res.end()
    }
  } finally {
    clearInterval(pingTimer)
    req.off('close', handleDisconnect)
    sessionManager.releaseWorker(sessionId, worker)
  }
}

const createMessagesRouter = ({ pool, sessionManager }: MessagesRouterOptions): Router => {
  const router = Router()
  router.post('/v1/messages', async (req: Request, res: Response): Promise<void> => {
    const anthropicBeta = req.headers['anthropic-beta'] as string | undefined
    const anthropicVersion = req.headers['anthropic-version'] as string | undefined
    if (anthropicBeta || anthropicVersion) {
      logger.info({ anthropicBeta, anthropicVersion }, 'anthropic headers')
    }
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
