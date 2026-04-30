import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { synthesizeToolUse, synthesizeInput, isEmulateEnabled, NAME_BY_KIND, stableToolUseId } from './tool-synth.js'
import type { ToolCallStartLike } from './tool-renderer.js'

const restore = (key: string, prev: string | undefined): void => {
  if (prev === undefined) delete process.env[key]
  else process.env[key] = prev
}

describe('isEmulateEnabled', () => {
  let prev: string | undefined
  beforeEach(() => { prev = process.env['EMULATE_CC_TOOLS'] })
  afterEach(() => { restore('EMULATE_CC_TOOLS', prev) })

  it('defaults to true when env unset', () => {
    delete process.env['EMULATE_CC_TOOLS']
    expect(isEmulateEnabled()).toBe(true)
  })
  it('false only when env explicitly "false"', () => {
    process.env['EMULATE_CC_TOOLS'] = 'false'
    expect(isEmulateEnabled()).toBe(false)
  })
  it('true for any other value', () => {
    process.env['EMULATE_CC_TOOLS'] = 'true'
    expect(isEmulateEnabled()).toBe(true)
    process.env['EMULATE_CC_TOOLS'] = '1'
    expect(isEmulateEnabled()).toBe(true)
    process.env['EMULATE_CC_TOOLS'] = ''
    expect(isEmulateEnabled()).toBe(true)
  })
  it('case-insensitive false', () => {
    process.env['EMULATE_CC_TOOLS'] = 'FALSE'
    expect(isEmulateEnabled()).toBe(false)
    process.env['EMULATE_CC_TOOLS'] = 'False'
    expect(isEmulateEnabled()).toBe(false)
  })
})

describe('synthesizeToolUse', () => {
  let prev: string | undefined
  beforeEach(() => { prev = process.env['EMULATE_CC_TOOLS']; delete process.env['EMULATE_CC_TOOLS'] })
  afterEach(() => { restore('EMULATE_CC_TOOLS', prev) })

  it('returns null when emulation disabled', () => {
    process.env['EMULATE_CC_TOOLS'] = 'false'
    const call: ToolCallStartLike = { toolCallId: 't', title: 'Edit', kind: 'edit' }
    expect(synthesizeToolUse(call, 'toolu_x')).toBeNull()
  })

  it('uses kiro_ prefix for all kinds', () => {
    for (const [kind, name] of Object.entries(NAME_BY_KIND)) {
      const call: ToolCallStartLike = { toolCallId: 't', kind }
      const result = synthesizeToolUse(call, 'toolu_x')
      expect(result?.name).toBe(name)
      expect(result?.name.startsWith('kiro_')).toBe(true)
    }
  })

  it('preserves provided toolUseId', () => {
    const call: ToolCallStartLike = { toolCallId: 't', kind: 'edit' }
    const result = synthesizeToolUse(call, 'toolu_specific')
    expect(result?.toolUseId).toBe('toolu_specific')
  })

  it('derives stable toolUseId from toolCallId when not provided', () => {
    const call: ToolCallStartLike = { toolCallId: 'kiro-tc-123', kind: 'edit' }
    const a = synthesizeToolUse(call)
    const b = synthesizeToolUse(call)
    expect(a?.toolUseId).toBe(b?.toolUseId)
    expect(a?.toolUseId.startsWith('toolu_')).toBe(true)
    expect(a?.toolUseId.length).toBe(30) // toolu_ + 24 hex
  })

  it('different toolCallIds produce different toolUseIds', () => {
    const a = synthesizeToolUse({ toolCallId: 'a', kind: 'edit' })
    const b = synthesizeToolUse({ toolCallId: 'b', kind: 'edit' })
    expect(a?.toolUseId).not.toBe(b?.toolUseId)
  })
})

describe('stableToolUseId', () => {
  it('is deterministic', () => {
    expect(stableToolUseId('foo')).toBe(stableToolUseId('foo'))
  })
  it('produces toolu_ prefix with 24 hex chars', () => {
    const id = stableToolUseId('any-acp-id')
    expect(id).toMatch(/^toolu_[0-9a-f]{24}$/)
  })
})

describe('synthesizeInput - edit kind', () => {
  it('emits {file_path, old_string, new_string} for edit with diff', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'edit',
      content: [{ type: 'diff', path: '/a.ts', oldText: 'foo', newText: 'bar' }],
    }
    expect(synthesizeInput(call)).toEqual({
      file_path: '/a.ts',
      old_string: 'foo',
      new_string: 'bar',
    })
  })

  it('emits {file_path, content} (Write shape) when oldText is empty', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'edit',
      content: [{ type: 'diff', path: '/new.ts', oldText: null, newText: 'fresh' }],
    }
    expect(synthesizeInput(call)).toEqual({ file_path: '/new.ts', content: 'fresh' })
  })

  it('falls back to file_path from locations when no diff', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'edit',
      locations: [{ path: '/x.ts' }],
    }
    expect(synthesizeInput(call)).toMatchObject({ file_path: '/x.ts' })
  })
})

describe('synthesizeInput - execute kind', () => {
  it('emits {command, description} from rawInput', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'execute',
      title: 'Run tests',
      rawInput: { command: 'npm test' },
    }
    expect(synthesizeInput(call)).toEqual({ command: 'npm test', description: 'Run tests' })
  })

  it('extracts command from text content when rawInput missing', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'execute',
      title: 'Run',
      content: [{ type: 'content', content: { type: 'text', text: 'ls -la' } }],
    }
    expect(synthesizeInput(call)).toEqual({ command: 'ls -la', description: 'Run' })
  })
})

describe('synthesizeInput - read kind', () => {
  it('emits {file_path} from locations with offset', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'read',
      locations: [{ path: '/foo.ts', line: 42 }],
    }
    expect(synthesizeInput(call)).toEqual({ file_path: '/foo.ts', offset: 42 })
  })

  it('passes through rawInput.file_path when no locations', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'read',
      rawInput: { file_path: '/from-input.ts' },
    }
    expect(synthesizeInput(call)).toEqual({ file_path: '/from-input.ts' })
  })

  it('coerces rawInput.path → file_path', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'read',
      rawInput: { path: '/p.ts' },
    }
    expect(synthesizeInput(call)).toEqual({ file_path: '/p.ts' })
  })
})

describe('synthesizeInput - search kind', () => {
  it('emits {pattern, path} from rawInput', () => {
    const call: ToolCallStartLike = {
      toolCallId: 't',
      kind: 'search',
      rawInput: { pattern: 'TODO', path: 'src' },
    }
    expect(synthesizeInput(call)).toEqual({ pattern: 'TODO', path: 'src' })
  })
})
