import { describe, it, expect } from 'vitest'
import { toAcpPrompt, toAnthropicMessage, estimateTokens, mapStopReason, extractCwdFromRequest } from './translator.js'
import type { AnthropicRequest, CollectedUpdate } from './translator.js'
import type { PromptResponse } from '@agentclientprotocol/sdk'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates tokens at 4 chars per token', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars / 4
  })

  it('rounds up partial tokens', () => {
    expect(estimateTokens('hi')).toBe(1) // 2 chars / 4 = 0.5 → 1
  })
})

describe('mapStopReason', () => {
  it('returns tool_use when hasToolUse is true', () => {
    expect(mapStopReason('end_turn', true)).toBe('tool_use')
  })

  it('returns end_turn for end_turn reason', () => {
    expect(mapStopReason('end_turn', false)).toBe('end_turn')
  })

  it('returns max_tokens for max_tokens reason', () => {
    expect(mapStopReason('max_tokens', false)).toBe('max_tokens')
  })

  it('defaults to end_turn for unknown reasons', () => {
    expect(mapStopReason('something_else', false)).toBe('end_turn')
  })

  it('maps cancelled to end_turn', () => {
    expect(mapStopReason('cancelled', false)).toBe('end_turn')
  })

  it('maps refusal to refusal', () => {
    expect(mapStopReason('refusal', false)).toBe('refusal')
  })
})

describe('toAcpPrompt', () => {
  it('embeds system text in persona prefix block', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      system: 'You are helpful.',
    }
    const actualBlocks = toAcpPrompt(inputRequest)
    expect(actualBlocks[0]!.type).toBe('text')
    const text = (actualBlocks[0] as { text: string }).text
    expect(text).toContain('<<system_instructions>>')
    expect(text).toContain('You are helpful.')
  })

  it('joins array system blocks into persona prefix', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
    }
    const actualBlocks = toAcpPrompt(inputRequest)
    const text = (actualBlocks[0] as { text: string }).text
    expect(text).toContain('Part 1')
    expect(text).toContain('Part 2')
  })

  it('with existing session: sends only last user message', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    expect(actualBlocks).toEqual([{ type: 'text', text: 'second' }])
  })

  it('without session: prefixes persona block then full history with role prefixes', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, false)
    // First block is persona, then history
    expect(actualBlocks).toHaveLength(4)
    expect((actualBlocks[0] as { text: string }).text).toContain('<<system_instructions>>')
    expect(actualBlocks[1]).toEqual({ type: 'text', text: '[Human]: first' })
    expect(actualBlocks[2]).toEqual({ type: 'text', text: '[Assistant]: reply' })
    expect(actualBlocks[3]).toEqual({ type: 'text', text: '[Human]: second' })
  })

  it('handles content block arrays with text and image (existing session)', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    expect(actualBlocks).toEqual([
      { type: 'text', text: 'describe this' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ])
  })

  it('converts tool_result blocks to framed text (existing session)', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'result text' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    const text = (actualBlocks[0] as { text: string }).text
    expect(text).toContain('<<tool_result tool_use_id="tool_1">>')
    expect(text).toContain('result text')
    expect(text).toContain('<<end_tool_result>>')
    expect(text).toContain('ground truth')
  })

  it('with existing session: returns empty array when no user messages exist', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'assistant', content: 'hi' }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    expect(actualBlocks).toEqual([])
  })

  it('includes tool catalog with schemas in persona prefix (no session)', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      tools: [
        { name: 'Read', description: 'Read a file', type: 'function', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
        { name: 'Bash', description: 'Run bash commands', type: 'function' },
      ],
    }
    const actualBlocks = toAcpPrompt(inputRequest, false)
    const personaText = (actualBlocks[0] as { text: string }).text
    expect(personaText).toContain('Available Client Tools')
    expect(personaText).toContain('Read')
    expect(personaText).toContain('Bash')
    expect(personaText).toContain('"path"')
  })

  it('persona prefix forwards filtered tools (system tools still listed since persona forwards all named tools)', () => {
    // Persona forwards all named tools verbatim; CC clients control what they ship.
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      tools: [
        { name: 'Read', description: 'Read a file', type: 'function' },
      ],
    }
    const actualBlocks = toAcpPrompt(inputRequest, false)
    const personaText = (actualBlocks[0] as { text: string }).text
    expect(personaText).toContain('Read')
  })
})

describe('toAnthropicMessage', () => {
  const mockPromptResponse: PromptResponse = { stopReason: 'end_turn' }

  it('collects text from agent_message_chunk updates', () => {
    const inputUpdates: CollectedUpdate[] = [
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } as never },
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } as never },
    ]
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage(inputUpdates, mockPromptResponse, inputRequest)
    expect(actualResponse.type).toBe('message')
    expect(actualResponse.role).toBe('assistant')
    expect(actualResponse.content).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(actualResponse.stop_reason).toBe('end_turn')
    expect(actualResponse.model).toBe('kiro')
    expect(actualResponse.id).toMatch(/^msg_/)
  })

  it('renders tool_call updates with title and rawInput', () => {
    const inputUpdates: CollectedUpdate[] = [
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_1',
          title: 'read_file',
          rawInput: { path: '/tmp/test.txt' },
        } as never,
      },
    ]
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'read file' }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage(inputUpdates, mockPromptResponse, inputRequest)
    // With EMULATE_CC_TOOLS (default), output is text block + synthesized kiro_* tool_use.
    const textBlock = actualResponse.content.find((b) => b.type === 'text')
    expect(textBlock).toBeDefined()
    const text = (textBlock as { text: string }).text
    expect(text).toContain('read_file')
    expect(text).toContain('/tmp/test.txt')
    const toolUse = actualResponse.content.find((b) => b.type === 'tool_use')
    expect(toolUse).toBeDefined()
    expect((toolUse as { name: string }).name).toMatch(/^kiro_/)
    expect(actualResponse.stop_reason).toBe('end_turn')
  })

  it('estimates input and output tokens', () => {
    const inputUpdates: CollectedUpdate[] = [
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '12345678' } } as never },
    ]
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'abcdefgh' }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage(inputUpdates, mockPromptResponse, inputRequest)
    expect(actualResponse.usage.input_tokens).toBe(2) // 8 chars / 4
    expect(actualResponse.usage.output_tokens).toBe(2) // 8 chars / 4
  })

  it('includes system text in input token count', () => {
    const inputUpdates: CollectedUpdate[] = []
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
      system: '12345678',
    }
    const actualResponse = toAnthropicMessage(inputUpdates, mockPromptResponse, inputRequest)
    // "hi" (2) + "12345678" (8) = 10 chars / 4 = 2.5 → 3
    expect(actualResponse.usage.input_tokens).toBe(3)
  })
})

describe('toAcpPrompt - thinking and special blocks', () => {
  it('strips thinking blocks from content (existing session)', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'thinking', thinking: 'internal thought', signature: 'sig' } as any,
          { type: 'text', text: 'actual message' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    const textBlocks = actualBlocks.filter((b) => b.type === 'text' && (b as { text: string }).text.length > 0)
    expect(textBlocks).toEqual([{ type: 'text', text: 'actual message' }])
  })

  it('strips redacted_thinking blocks from content', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'redacted_thinking', data: 'encrypted' } as any,
          { type: 'text', text: 'visible message' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    const textBlocks = actualBlocks.filter((b) => b.type === 'text' && (b as { text: string }).text.length > 0)
    expect(textBlocks).toEqual([{ type: 'text', text: 'visible message' }])
  })

  it('drops synthesized kiro_* tool_use blocks from replayed history', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Editing file.' },
          { type: 'tool_use', id: 'toolu_synth1', name: 'kiro_Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } } as never,
          { type: 'text', text: 'Done.' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    const allText = actualBlocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('|')
    expect(allText).not.toContain('kiro_Edit')
    expect(allText).not.toContain('toolu_synth1')
  })

  it('drops paired tool_result for synthesized kiro_* tool_use', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_use', id: 'toolu_synth1', name: 'kiro_Bash', input: { command: 'ls' } } as never,
          { type: 'tool_result', tool_use_id: 'toolu_synth1', content: 'fake output' },
          { type: 'text', text: 'real user message' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    const allText = actualBlocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('|')
    expect(allText).not.toContain('toolu_synth1')
    expect(allText).not.toContain('fake output')
    expect(allText).toContain('real user message')
  })

  it('drops tool_result with "No such tool: kiro_" error even without paired tool_use', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_lost', content: 'No such tool: kiro_Bash' },
          { type: 'text', text: 'continue' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    const allText = actualBlocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('|')
    expect(allText).not.toContain('No such tool')
    expect(allText).toContain('continue')
  })

  it('keeps real (non-kiro_) tool_use and tool_result pairs', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_use', id: 'toolu_real', name: 'WebSearch', input: { query: 'foo' } } as never,
          { type: 'tool_result', tool_use_id: 'toolu_real', content: 'search result' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    const allText = actualBlocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('|')
    expect(allText).toContain('WebSearch')
    expect(allText).toContain('search result')
  })

  it('handles tool_use blocks in content by JSON-stringifying', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: '/tmp' } } as any,
        ],
      }],
      max_tokens: 1024,
    }
    const actualBlocks = toAcpPrompt(inputRequest, true)
    expect(actualBlocks[0]!.type).toBe('text')
    expect((actualBlocks[0] as { text: string }).text).toContain('read_file')
  })

  it('handles system prompt with cache_control blocks (embedded in persona)', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'System prompt', cache_control: { type: 'ephemeral' } },
      ],
    }
    const actualBlocks = toAcpPrompt(inputRequest)
    const text = (actualBlocks[0] as { text: string }).text
    expect(text).toContain('System prompt')
  })

  it('returns null tool context when all tools are system tools', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      tools: [
        { name: 'web_search', type: 'web_search_20250305' },
        { name: 'ToolSearch', type: 'function' },
      ],
    }
    const actualBlocks = toAcpPrompt(inputRequest, false)
    const toolBlock = actualBlocks.find((b) => b.type === 'text' && (b as { text: string }).text.startsWith('Available tools:'))
    expect(toolBlock).toBeUndefined()
  })
})

describe('toAnthropicMessage - additional coverage', () => {
  const mockPromptResponse: PromptResponse = { stopReason: 'end_turn' }

  it('collects thinking from agent_thought_chunk updates', () => {
    const inputUpdates: CollectedUpdate[] = [
      { update: { sessionUpdate: 'agent_thought_chunk', content: { thought: 'thinking...' } } as never },
      { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } } as never },
    ]
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'think about this' }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage(inputUpdates, mockPromptResponse, inputRequest)
    expect(actualResponse.content[0]).toEqual({ type: 'thinking', thinking: 'thinking...' })
    expect(actualResponse.content[1]).toEqual({ type: 'text', text: 'answer' })
  })

  it('handles tool_call_update by including tool title in text', () => {
    const inputUpdates: CollectedUpdate[] = [
      {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_1',
          title: 'read_file',
          rawInput: { path: '/old' },
        } as never,
      },
      {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_1',
          rawInput: { path: '/new' },
          status: 'completed',
        } as never,
      },
    ]
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'read' }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage(inputUpdates, mockPromptResponse, inputRequest)
    const textBlock = actualResponse.content.find((b) => b.type === 'text')
    expect(textBlock).toBeDefined()
    expect((textBlock as { text: string }).text).toContain('⏺ read_file')
  })

  it('returns empty content array when no updates', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage([], mockPromptResponse, inputRequest)
    expect(actualResponse.content).toEqual([])
    expect(actualResponse.stop_reason).toBe('end_turn')
  })

  it('maps max_tokens stop reason', () => {
    const maxTokensResponse: PromptResponse = { stopReason: 'max_tokens' }
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage([], maxTokensResponse, inputRequest)
    expect(actualResponse.stop_reason).toBe('max_tokens')
  })

  it('includes array system text in input token count', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
      system: [{ type: 'text', text: '12345678' }],
    }
    const actualResponse = toAnthropicMessage([], mockPromptResponse, inputRequest)
    // "hi" (2) + "12345678" (8) = 10 / 4 = 2.5 → 3
    expect(actualResponse.usage.input_tokens).toBe(3)
  })

  it('handles content block arrays in input token estimation', () => {
    const inputRequest: AnthropicRequest = {
      model: 'kiro',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'abcd' },
          { type: 'text', text: 'efgh' },
        ],
      }],
      max_tokens: 1024,
    }
    const actualResponse = toAnthropicMessage([], mockPromptResponse, inputRequest)
    // "abcd" (4) + "efgh" (4) = 8 / 4 = 2
    expect(actualResponse.usage.input_tokens).toBe(2)
  })
})

describe('extractCwdFromRequest', () => {
  it('extracts cwd from string system prompt', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      system: 'You are helpful.\n\nCurrent directory: /Users/sabeur/Documents/work/GitHub/personal/hizmoo\n\nMore context here.',
    }
    expect(extractCwdFromRequest(request)).toBe('/Users/sabeur/Documents/work/GitHub/personal/hizmoo')
  })

  it('extracts cwd from array system prompt', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      system: [
        { type: 'text' as const, text: 'You are helpful.' },
        { type: 'text' as const, text: 'Current directory: /home/user/project' },
      ],
    }
    expect(extractCwdFromRequest(request)).toBe('/home/user/project')
  })

  it('returns null when no system prompt', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
    }
    expect(extractCwdFromRequest(request)).toBeNull()
  })

  it('returns null when system prompt has no cwd', () => {
    const request: AnthropicRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
    }
    expect(extractCwdFromRequest(request)).toBeNull()
  })
})
