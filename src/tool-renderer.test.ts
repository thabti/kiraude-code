import { describe, it, expect } from 'vitest'
import { renderToolCallStart, renderToolCallUpdate, renderPlan, renderDiff, formatHeader, buildRichTitle } from './tool-renderer.js'
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

describe('buildRichTitle', () => {
  it('renders Read with offset+limit range', () => {
    const out = buildRichTitle({
      toolCallId: 't',
      kind: 'read',
      title: 'Read',
      rawInput: { file_path: '/proj/a.ts', offset: 10, limit: 20 },
    }, '/proj')
    expect(out).toBe('Read a.ts (10-30)')
  })

  it('renders Edit with relative path', () => {
    const out = buildRichTitle({
      toolCallId: 't',
      kind: 'edit',
      title: 'kiro title',
      rawInput: { file_path: '/proj/src/foo.ts' },
    }, '/proj')
    expect(out).toBe('Edit src/foo.ts')
  })

  it('renders Bash with command (truncates long)', () => {
    const out = buildRichTitle({
      toolCallId: 't',
      kind: 'execute',
      title: '',
      rawInput: { command: 'npm test' },
    }, '/proj')
    expect(out).toBe('Bash npm test')
  })

  it('renders Grep with pattern + path', () => {
    const out = buildRichTitle({
      toolCallId: 't',
      kind: 'search',
      title: '',
      rawInput: { pattern: 'TODO', path: '/proj/src' },
    }, '/proj')
    expect(out).toBe('Grep "TODO" in src')
  })

  it('falls back to title when rawInput lacks structure', () => {
    const out = buildRichTitle({
      toolCallId: 't',
      kind: 'other',
      title: 'Whatever',
    }, '/proj')
    expect(out).toBe('Whatever')
  })

  it('relativizes absolute paths inside fallback title', () => {
    const out = buildRichTitle({
      toolCallId: 't',
      kind: 'other',
      title: 'Did /proj/x.ts and /proj/y.ts',
    }, '/proj')
    expect(out).toBe('Did x.ts and y.ts')
  })
})

describe('renderPlan with priorities', () => {
  it('marks high priority entries', () => {
    const out = renderPlan([
      { content: 'Critical fix', status: 'pending', priority: 'high' },
      { content: 'Polish', status: 'pending', priority: 'low' },
      { content: 'Routine', status: 'pending' },
    ])
    expect(out).toContain('Critical fix 🔥')
    expect(out).toContain('Polish ▽')
    // medium / unspecified gets no marker
    expect(out).toMatch(/\[ \] Routine\n/)
  })
})
