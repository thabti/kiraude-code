import { describe, it, expect } from 'vitest'
import { unreachable, markdownFence } from './utils.js'

describe('unreachable', () => {
  it('throws when called', () => {
    expect(() => unreachable('x' as never)).toThrow(/Unreachable/)
  })
})

describe('markdownFence', () => {
  it('uses 3 backticks for plain text', () => {
    expect(markdownFence('hello')).toBe('```\nhello\n```')
  })

  it('preserves trailing newline', () => {
    expect(markdownFence('hello\n')).toBe('```\nhello\n```')
  })

  it('escalates to 4 backticks when text contains 3', () => {
    const out = markdownFence('```\ninner\n```')
    expect(out.startsWith('````')).toBe(true)
    expect(out.endsWith('````')).toBe(true)
    expect(out).toContain('```\ninner\n```')
  })

  it('escalates further to 5 when text contains 4', () => {
    const out = markdownFence('````\nfour\n````')
    expect(out.startsWith('`````')).toBe(true)
    expect(out.endsWith('`````')).toBe(true)
  })

  it('appends language hint', () => {
    expect(markdownFence('cmd', 'bash').startsWith('```bash\n')).toBe(true)
  })

  it('handles empty text', () => {
    expect(markdownFence('')).toBe('```\n\n```')
  })
})
