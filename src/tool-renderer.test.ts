import { describe, it, expect } from 'vitest'
import { renderToolCallStart, renderToolCallUpdate, renderPlan, renderDiff, formatHeader } from './tool-renderer.js'
import type { ToolCallStartLike, ToolCallState } from './tool-renderer.js'

describe('renderToolCallStart', () => {
  it('renders edit kind with diff content', () => {
    const call: ToolCallStartLike = {
      toolCallId: 'tc1',
      title: 'Edit src/foo.ts',
      kind: 'edit',
      content: [
        { type: 'diff', path: 'src/foo.ts', oldText: 'a\nb\n', newText: 'a\nc\n' },
      ],
    }
    const out = renderToolCallStart(call)
    expect(out).toContain('✏️')
    expect(out).toContain('Edit src/foo.ts')
    expect(out).toContain('```diff')
    expect(out).toContain('-b')
    expect(out).toContain('+c')
  })

  it('renders execute kind with terminal content', () => {
    const call: ToolCallStartLike = {
      toolCallId: 'tc2',
      title: 'Run npm test',
      kind: 'execute',
      content: [
        { type: 'content', content: { type: 'text', text: '> npm test\nPASS' } },
      ],
    }
    const out = renderToolCallStart(call)
    expect(out).toContain('🖥️')
    expect(out).toContain('```bash')
    expect(out).toContain('PASS')
  })

  it('renders read kind with location', () => {
    const call: ToolCallStartLike = {
      toolCallId: 'tc3',
      title: 'Read file',
      kind: 'read',
      locations: [{ path: '/tmp/foo.ts', line: 42 }],
    }
    const out = renderToolCallStart(call)
    expect(out).toContain('📖')
    expect(out).toContain('/tmp/foo.ts:42')
  })

  it('falls back to default icon for unknown kind', () => {
    const call: ToolCallStartLike = { toolCallId: 'tc', title: 'Mystery' }
    const out = renderToolCallStart(call)
    expect(out).toContain('⏺')
  })

  it('includes raw input preview when small', () => {
    const call: ToolCallStartLike = {
      toolCallId: 'tc',
      title: 'Search',
      kind: 'search',
      rawInput: { pattern: 'TODO' },
    }
    const out = renderToolCallStart(call)
    expect(out).toContain('TODO')
  })
})

describe('renderToolCallUpdate', () => {
  it('emits append-only delta when new render extends old', () => {
    const initial: ToolCallStartLike = {
      toolCallId: 'tc',
      title: 'Edit',
      kind: 'edit',
    }
    const initialRender = renderToolCallStart(initial)
    const prev: ToolCallState = {
      toolCallId: 'tc',
      blockIndex: 0,
      rendered: initialRender,
      status: 'pending',
    }
    const update: ToolCallStartLike = {
      toolCallId: 'tc',
      title: 'Edit',
      kind: 'edit',
      content: [{ type: 'diff', path: 'a.ts', oldText: '', newText: 'x' }],
    }
    const result = renderToolCallUpdate(prev, update)
    expect(result.delta.length).toBeGreaterThan(0)
    expect(result.rendered).toContain(initialRender)
    expect(result.rendered).toContain('```diff')
  })

  it('appends failure marker when status flips to failed', () => {
    const prev: ToolCallState = {
      toolCallId: 'tc',
      blockIndex: 0,
      rendered: '⏺ Run\n',
      status: 'in_progress',
    }
    const update: ToolCallStartLike = { toolCallId: 'tc', title: 'Run', status: 'failed' }
    const result = renderToolCallUpdate(prev, update)
    expect(result.status).toBe('failed')
    expect(result.delta).toContain('failed')
  })
})

describe('renderPlan', () => {
  it('renders entries as markdown checklist', () => {
    const out = renderPlan([
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress' },
      { content: 'Step 3', status: 'pending' },
    ])
    expect(out).toContain('📋')
    expect(out).toContain('[x] Step 1')
    expect(out).toContain('[~] Step 2')
    expect(out).toContain('[ ] Step 3')
  })

  it('returns empty string for empty entries', () => {
    expect(renderPlan([])).toBe('')
  })
})

describe('renderDiff', () => {
  it('produces unified diff fenced block', () => {
    const out = renderDiff('a.ts', 'one\ntwo\n', 'one\ntwo updated\n')
    expect(out.startsWith('```diff')).toBe(true)
    expect(out.endsWith('```')).toBe(true)
    expect(out).toContain('--- a.ts')
    expect(out).toContain('+++ a.ts')
    expect(out).toContain('-two')
    expect(out).toContain('+two updated')
  })

  it('handles new file (null oldText)', () => {
    const out = renderDiff('new.ts', null, 'fresh\ncontent\n')
    expect(out).toContain('+fresh')
    expect(out).toContain('+content')
  })
})

describe('formatHeader', () => {
  it('uses kind icon when provided', () => {
    expect(formatHeader({ toolCallId: 't', title: 'X', kind: 'edit' })).toContain('✏️')
    expect(formatHeader({ toolCallId: 't', title: 'X', kind: 'execute' })).toContain('🖥️')
  })
})
