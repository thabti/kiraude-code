import { describe, it, expect } from 'vitest'
import { buildPersonaPrefix, PERSONA_HEADER } from './persona.js'
import type { AnthropicRequest } from './translator.js'

describe('buildPersonaPrefix', () => {
  it('always includes persona header', () => {
    const req: AnthropicRequest = { model: 'kiro', messages: [], max_tokens: 1024 }
    const out = buildPersonaPrefix(req, null)
    expect(out).toContain(PERSONA_HEADER.split('\n')[0]) // first line of header
    expect(out).toContain('Behave like Claude Code')
  })

  it('embeds client system prompt verbatim', () => {
    const req: AnthropicRequest = { model: 'kiro', messages: [], max_tokens: 1024 }
    const out = buildPersonaPrefix(req, 'You are helpful and curt.')
    expect(out).toContain('## Client System Prompt')
    expect(out).toContain('You are helpful and curt.')
  })

  it('renders tool catalog with input_schema as JSON', () => {
    const req: AnthropicRequest = {
      model: 'kiro',
      messages: [],
      max_tokens: 1024,
      tools: [
        {
          name: 'Edit',
          description: 'Edit a file',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
    }
    const out = buildPersonaPrefix(req, null)
    expect(out).toContain('Available Client Tools')
    expect(out).toContain('### Edit')
    expect(out).toContain('Edit a file')
    expect(out).toContain('"file_path"')
  })

  it('skips tool catalog when tools array is empty', () => {
    const req: AnthropicRequest = { model: 'kiro', messages: [], max_tokens: 1024, tools: [] }
    const out = buildPersonaPrefix(req, null)
    expect(out).not.toContain('Available Client Tools')
  })

  it('skips unnamed tools', () => {
    const req: AnthropicRequest = {
      model: 'kiro',
      messages: [],
      max_tokens: 1024,
      tools: [{ description: 'no name' }, { name: 'Real', description: 'r' }],
    }
    const out = buildPersonaPrefix(req, null)
    expect(out).toContain('### Real')
    expect(out).not.toContain('no name')
  })

  it('truncates very long tool descriptions', () => {
    const longDesc = 'x'.repeat(2000)
    const req: AnthropicRequest = {
      model: 'kiro',
      messages: [],
      max_tokens: 1024,
      tools: [{ name: 'Big', description: longDesc }],
    }
    const out = buildPersonaPrefix(req, null)
    expect(out).toContain('### Big')
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(longDesc.length)
  })
})
