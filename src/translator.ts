import crypto from 'node:crypto'
import type { ContentBlock, SessionUpdate, PromptResponse } from '@agentclientprotocol/sdk'

interface AnthropicMessage {
  readonly role: string
  readonly content: string | ReadonlyArray<AnthropicContentBlock>
}

interface AnthropicTextBlock {
  readonly type: 'text'
  readonly text: string
}

interface AnthropicImageBlock {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64' | 'url'
    readonly media_type?: string
    readonly data?: string
    readonly url?: string
  }
}

interface AnthropicThinkingContentBlock {
  readonly type: 'thinking'
  readonly thinking: string
  readonly signature?: string
}

interface AnthropicRedactedThinkingBlock {
  readonly type: 'redacted_thinking'
  readonly data: string
}

interface AnthropicDocumentBlock {
  readonly type: 'document'
  readonly source: {
    readonly type: 'base64' | 'text'
    readonly media_type: string
    readonly data: string
  }
  readonly title?: string
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingContentBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicDocumentBlock

interface AnthropicToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: string
  readonly input: unknown
}

interface AnthropicToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: string | ReadonlyArray<AnthropicTextBlock>
}

interface AnthropicTool {
  readonly type?: string
  readonly name?: string
  readonly description?: string
  readonly input_schema?: unknown
  // Strip these proxy-side-only fields before forwarding
  readonly defer_loading?: boolean
  readonly eager_input_streaming?: boolean
  readonly cache_control?: unknown
  readonly strict?: boolean
}

interface AnthropicThinking {
  readonly type: 'enabled' | 'adaptive'
  readonly budget_tokens?: number
}

interface AnthropicRequest {
  readonly model: string
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly max_tokens: number
  readonly system?: string | ReadonlyArray<{ readonly type: 'text'; readonly text: string; readonly cache_control?: unknown }>
  readonly stream?: boolean
  readonly tools?: ReadonlyArray<AnthropicTool>
  readonly tool_choice?: unknown
  readonly thinking?: AnthropicThinking
  readonly temperature?: number
  readonly metadata?: { readonly user_id?: string; readonly session_id?: string }
  readonly betas?: ReadonlyArray<string>
}

interface AnthropicResponse {
  readonly id: string
  readonly type: 'message'
  readonly role: 'assistant'
  readonly content: AnthropicResponseBlock[]
  readonly model: string
  readonly stop_reason: string | null
  readonly stop_sequence: string | null
  readonly usage: {
    readonly input_tokens: number
    readonly output_tokens: number
  }
}

type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicThinkingBlock

interface AnthropicThinkingBlock {
  readonly type: 'thinking'
  readonly thinking: string
}

interface CollectedUpdate {
  readonly update: SessionUpdate
}

const CHARS_PER_TOKEN = 4

const SYSTEM_TOOL_TYPES = new Set([
  'web_search_20250305',
  'computer_use_20241022',
  'computer_use_20250124',
  'text_editor_20241022',
  'text_editor_20250124',
  'bash_20241022',
  'bash_20250124',
])

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

/** Extract the working directory from Claude Code's system prompt. */
const extractCwdFromRequest = (request: AnthropicRequest): string | null => {
  const systemText = extractSystemText(request)
  if (!systemText) return null
  const match = systemText.match(/Current directory:\s*(.+)/i)
  if (!match?.[1]) return null
  return match[1].trim()
}

const isSystemTool = (tool: AnthropicTool): boolean => {
  if (tool.type && SYSTEM_TOOL_TYPES.has(tool.type)) return true
  if (tool.name === 'web_search') return true
  if (tool.name === 'ToolSearch') return true
  return false
}

const buildToolContextBlock = (tools: ReadonlyArray<AnthropicTool>): ContentBlock | null => {
  const userTools = tools.filter((t) => !isSystemTool(t) && t.name)
  if (userTools.length === 0) return null
  const lines = userTools.map((t) => {
    const desc = t.description ? `: ${t.description}` : ''
    return `- ${t.name}${desc}`
  })
  return { type: 'text', text: `Available tools:\n${lines.join('\n')}` }
}

/**
 * Converts an Anthropic request to ACP content blocks.
 *
 * isExistingSession=true: only last user message (ACP session has prior context).
 * isExistingSession=false: full history concatenated with role prefixes.
 */
const toAcpPrompt = (request: AnthropicRequest, isExistingSession = false): Array<ContentBlock> => {
  const blocks: Array<ContentBlock> = []

  if (isExistingSession) {
    const lastUserMessage = findLastUserMessage(request.messages)
    if (lastUserMessage) {
      blocks.push(...convertMessageContent(lastUserMessage.content))
    }
    return blocks
  }

  const systemText = extractSystemText(request)
  if (systemText) {
    blocks.push({ type: 'text', text: systemText })
  }

  if (request.tools && request.tools.length > 0) {
    const toolBlock = buildToolContextBlock(request.tools)
    if (toolBlock) blocks.push(toolBlock)
  }

  for (const message of request.messages) {
    const contentBlocks = convertMessageContent(message.content)
    if (contentBlocks.length === 0) continue
    const rolePrefix = message.role === 'user' ? 'Human' : 'Assistant'
    const firstBlock = contentBlocks[0]!
    if (firstBlock.type === 'text') {
      blocks.push({ type: 'text', text: `[${rolePrefix}]: ${firstBlock.text}` })
      blocks.push(...contentBlocks.slice(1))
    } else {
      blocks.push({ type: 'text', text: `[${rolePrefix}]:` })
      blocks.push(...contentBlocks)
    }
  }

  return blocks
}

const extractSystemText = (request: AnthropicRequest): string | null => {
  if (!request.system) return null
  if (typeof request.system === 'string') return request.system
  return request.system.map((block) => block.text).join('\n')
}

const findLastUserMessage = (messages: ReadonlyArray<AnthropicMessage>): AnthropicMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return messages[i]!
  }
  return null
}

const convertMessageContent = (content: string | ReadonlyArray<AnthropicContentBlock>): Array<ContentBlock> => {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content.map(convertSingleBlock).filter((b) => b.type !== 'text' || (b as { text: string }).text.length > 0)
}

const convertSingleBlock = (block: AnthropicContentBlock): ContentBlock => {
  if (block.type === 'thinking') {
    return { type: 'text', text: '' }
  }
  if (block.type === 'redacted_thinking') {
    return { type: 'text', text: '' }
  }
  if (block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'image') {
    if (block.source.type === 'base64' && block.source.data) {
      return { type: 'image', data: block.source.data, mimeType: block.source.media_type ?? 'image/png' }
    }
    if (block.source.type === 'url' && block.source.url) {
      return { type: 'text', text: `[Image: ${block.source.url}]` }
    }
    return { type: 'text', text: '[Image: unsupported source]' }
  }
  if (block.type === 'tool_result') {
    const text = typeof block.content === 'string'
      ? block.content
      : block.content.map((b) => b.text).join('\n')
    return { type: 'text', text: `[Tool Result for ${block.tool_use_id}]: ${text}` }
  }
  if (block.type === 'tool_use') {
    return { type: 'text', text: `[Tool Use: ${block.name}(${JSON.stringify(block.input)})]` }
  }
  if (block.type === 'document') {
    const title = block.title ? `[Document: ${block.title}]\n` : '[Document]\n'
    if (block.source.media_type === 'text/plain') {
      return { type: 'text', text: `${title}${block.source.data}` }
    }
    return { type: 'text', text: `${title}[${block.source.media_type} document, ${block.source.data.length} bytes base64]` }
  }
  return { type: 'text', text: JSON.stringify(block) }
}

const toAnthropicMessage = (
  updates: ReadonlyArray<CollectedUpdate>,
  promptResponse: PromptResponse,
  request: AnthropicRequest,
): AnthropicResponse => {
  const content: AnthropicResponseBlock[] = []
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

  let outputText = ''
  let thinkingText = ''
  const toolCalls: Map<string, { title: string; toolCallId: string; input: unknown }> = new Map()

  for (const { update } of updates) {
    if (update.sessionUpdate === 'agent_message_chunk') {
      const block = update.content
      if (block.type === 'text') {
        outputText += block.text
      }
    }
    if (update.sessionUpdate === 'agent_thought_chunk') {
      thinkingText += (update.content as { thought?: string }).thought ?? ''
    }
    if (update.sessionUpdate === 'tool_call') {
      toolCalls.set(update.toolCallId, {
        title: update.title,
        toolCallId: update.toolCallId,
        input: update.rawInput ?? {},
      })
    }
    if (update.sessionUpdate === 'tool_call_update') {
      const existing = toolCalls.get(update.toolCallId)
      if (existing && update.rawInput !== undefined) {
        toolCalls.set(update.toolCallId, { ...existing, input: update.rawInput })
      }
    }
  }

  if (thinkingText.length > 0) {
    content.push({ type: 'thinking', thinking: thinkingText })
  }
  if (outputText.length > 0) {
    content.push({ type: 'text', text: outputText })
  }
  for (const [, tc] of toolCalls) {
    content.push({
      type: 'tool_use',
      id: tc.toolCallId,
      name: tc.title,
      input: tc.input,
    })
  }

  const hasToolUse = content.some((b) => b.type === 'tool_use')
  const stopReason = mapStopReason(promptResponse.stopReason, hasToolUse)

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    content,
    model: request.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(inputText),
      output_tokens: estimateTokens(outputText),
    },
  }
}

const mapStopReason = (acpReason: string, hasToolUse: boolean): string => {
  if (hasToolUse) return 'tool_use'
  if (acpReason === 'end_turn') return 'end_turn'
  if (acpReason === 'max_tokens') return 'max_tokens'
  return 'end_turn'
}

export { toAcpPrompt, toAnthropicMessage, estimateTokens, mapStopReason, extractCwdFromRequest }
export type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicResponseBlock,
  AnthropicThinkingBlock,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicImageBlock,
  AnthropicThinkingContentBlock,
  AnthropicRedactedThinkingBlock,
  AnthropicDocumentBlock,
  AnthropicTool,
  AnthropicThinking,
  CollectedUpdate,
}
