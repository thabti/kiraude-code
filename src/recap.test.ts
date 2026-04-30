import { describe, it, expect } from 'vitest'
import { clientHasTodoWrite, planToTodos, buildRecap, deriveActiveForm, relativizePath } from './recap.js'
import type { ToolCallState } from './tool-renderer.js'

describe('clientHasTodoWrite', () => {
  it('returns true when TodoWrite is in tools list', () => {
    expect(clientHasTodoWrite([{ name: 'TodoWrite' }, { name: 'Read' }])).toBe(true)
  })
  it('returns false when TodoWrite missing', () => {
    expect(clientHasTodoWrite([{ name: 'Read' }])).toBe(false)
  })
  it('returns false for undefined tools', () => {
    expect(clientHasTodoWrite(undefined)).toBe(false)
  })
  it('case-sensitive — todowrite ≠ TodoWrite', () => {
    expect(clientHasTodoWrite([{ name: 'todowrite' }])).toBe(false)
  })
})

describe('planToTodos', () => {
  it('maps each plan entry to a TodoItem with required fields', () => {
    const result = planToTodos([
      { content: 'Fix bug', status: 'pending' },
      { content: 'Run tests', status: 'in_progress' },
      { content: 'Ship it', status: 'completed' },
    ])
    expect(result.todos).toHaveLength(3)
    expect(result.todos[0]).toEqual({
      content: 'Fix bug',
      status: 'pending',
      activeForm: 'Fixing bug',
    })
    expect(result.todos[1]).toEqual({
      content: 'Run tests',
      status: 'in_progress',
      activeForm: 'Running tests',
    })
    expect(result.todos[2]).toEqual({
      content: 'Ship it',
      status: 'completed',
      activeForm: 'Shipping it',
    })
  })

  it('coerces unknown statuses to pending', () => {
    const result = planToTodos([{ content: 'X', status: 'weird' as never }])
    expect(result.todos[0]!.status).toBe('pending')
  })

  it('passes through already-continuous activeForm input', () => {
    const result = planToTodos([{ content: 'Running tests', status: 'in_progress' }])
    expect(result.todos[0]!.activeForm).toBe('Running tests')
  })
})

describe('deriveActiveForm', () => {
  it('appends ing for plain verb', () => {
    expect(deriveActiveForm('Fix bug')).toBe('Fixing bug')
  })
  it('drops trailing e before ing', () => {
    expect(deriveActiveForm('Make sandwich')).toBe('Making sandwich')
  })
  it('keeps continuous form unchanged', () => {
    expect(deriveActiveForm('Running tests')).toBe('Running tests')
  })
  it('handles single word', () => {
    expect(deriveActiveForm('Ship')).toBe('Shipping')
  })
  it('handles empty string', () => {
    expect(deriveActiveForm('')).toBe('Working')
  })
})

describe('relativizePath', () => {
  it('returns relative path when inside base', () => {
    expect(relativizePath('/project/src/foo.ts', '/project')).toBe('src/foo.ts')
  })
  it('preserves :line suffix', () => {
    expect(relativizePath('/project/src/foo.ts:42', '/project')).toBe('src/foo.ts:42')
  })
  it('preserves :line:col suffix', () => {
    expect(relativizePath('/project/src/foo.ts:42:7', '/project')).toBe('src/foo.ts:42:7')
  })
  it('returns original when path is outside base', () => {
    expect(relativizePath('/elsewhere/foo.ts', '/project')).toBe('/elsewhere/foo.ts')
  })
  it('leaves already-relative paths alone', () => {
    expect(relativizePath('src/foo.ts', '/project')).toBe('src/foo.ts')
  })
  it('handles base root edge case', () => {
    expect(relativizePath('/project', '/project')).toBe('.')
  })
})

describe('buildRecap with baseDir', () => {
  const makeState = (rendered: string, status = 'completed'): ToolCallState => ({
    toolCallId: 't',
    blockIndex: 0,
    rendered,
    status,
  })

  it('relativizes absolute paths in summary lines', () => {
    const calls = new Map<string, ToolCallState>()
    calls.set('a', makeState('📖 Read file — /project/src/foo.ts:10\n', 'completed'))
    const out = buildRecap(calls, false, { baseDir: '/project' })
    expect(out).toContain('`src/foo.ts:10`')
    expect(out).not.toContain('/project/src')
  })

  it('keeps absolute path when outside base', () => {
    const calls = new Map<string, ToolCallState>()
    calls.set('a', makeState('📖 Read — /tmp/other.txt\n'))
    const out = buildRecap(calls, false, { baseDir: '/project' })
    expect(out).toContain('/tmp/other.txt')
  })
})

describe('buildRecap', () => {
  const makeState = (rendered: string, status = 'completed'): ToolCallState => ({
    toolCallId: 't',
    blockIndex: 0,
    rendered,
    status,
  })

  it('returns empty string when no tools and no plan', () => {
    expect(buildRecap(new Map(), false)).toBe('')
  })

  it('lists each tool call with status icon', () => {
    const calls = new Map<string, ToolCallState>()
    calls.set('a', makeState('✏️ Edit src/foo.ts — src/foo.ts\n', 'completed'))
    calls.set('b', makeState('🖥️ Run tests\n', 'failed'))
    const out = buildRecap(calls, false)
    expect(out).toContain('## What changed')
    expect(out).toContain('✅')
    expect(out).toContain('Edit src/foo.ts')
    expect(out).toContain('❌')
    expect(out).toContain('Run tests')
    expect(out).toContain('`src/foo.ts`')
  })

  it('mentions plan update when present', () => {
    const out = buildRecap(new Map(), true)
    expect(out).toContain('## What changed')
    expect(out).toContain('Plan updated')
  })

  it('includes both tool calls and plan when both present', () => {
    const calls = new Map<string, ToolCallState>()
    calls.set('a', makeState('📖 Read file\n'))
    const out = buildRecap(calls, true)
    expect(out).toContain('Read file')
    expect(out).toContain('Plan updated')
  })

  it('uses correct status icon for each state', () => {
    const cases: Array<[string, string]> = [
      ['completed', '✅'],
      ['failed', '❌'],
      ['in_progress', '🔄'],
      ['pending', '⏳'],
    ]
    for (const [status, icon] of cases) {
      const calls = new Map([['t', makeState('⏺ Thing\n', status)]])
      expect(buildRecap(calls, false)).toContain(icon)
    }
  })
})
