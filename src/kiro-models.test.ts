import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveKiroModelId, getAnthropicModelList, getAnthropicModelById, fetchKiroModels } from './kiro-models.js'

describe('resolveKiroModelId', () => {
  it('resolves short alias "sonnet" to claude-sonnet-4.6', () => {
    expect(resolveKiroModelId('sonnet')).toBe('claude-sonnet-4.6')
  })

  it('resolves short alias "opus" to claude-opus-4.6', () => {
    expect(resolveKiroModelId('opus')).toBe('claude-opus-4.6')
  })

  it('resolves short alias "haiku" to claude-haiku-4.5', () => {
    expect(resolveKiroModelId('haiku')).toBe('claude-haiku-4.5')
  })

  it('resolves dash-notation claude-sonnet-4-6 to claude-sonnet-4.6', () => {
    expect(resolveKiroModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4.6')
  })

  it('resolves claude-opus-4-7 to claude-opus-4.6', () => {
    expect(resolveKiroModelId('claude-opus-4-7')).toBe('claude-opus-4.6')
  })

  it('resolves claude-opus-4 to claude-opus-4.6', () => {
    expect(resolveKiroModelId('claude-opus-4')).toBe('claude-opus-4.6')
  })

  it('resolves kiro alias to auto', () => {
    expect(resolveKiroModelId('kiro')).toBe('auto')
  })

  it('resolves kiro-sonnet to claude-sonnet-4.6', () => {
    expect(resolveKiroModelId('kiro-sonnet')).toBe('claude-sonnet-4.6')
  })

  it('passes through dot-notation model IDs', () => {
    expect(resolveKiroModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4.6')
  })

  it('passes through "auto"', () => {
    expect(resolveKiroModelId('auto')).toBe('auto')
  })

  it('falls back to default for unknown models', () => {
    const actual = resolveKiroModelId('unknown-model-xyz')
    expect(actual).toBe('auto')
  })
})

describe('getAnthropicModelList', () => {
  it('returns fallback models when no models are cached', () => {
    const actualList = getAnthropicModelList()
    expect(actualList.length).toBeGreaterThan(0)
  })

  it('includes auto model in fallback list', () => {
    const actualList = getAnthropicModelList()
    const autoModel = actualList.find((m) => m.id === 'auto')
    expect(autoModel).toBeDefined()
    expect(autoModel!.owned_by).toBe('kiro')
  })

  it('includes both dot and dash notation models', () => {
    const actualList = getAnthropicModelList()
    expect(actualList.find((m) => m.id === 'claude-sonnet-4.6')).toBeDefined()
    expect(actualList.find((m) => m.id === 'claude-sonnet-4-6')).toBeDefined()
  })

  it('includes short aliases', () => {
    const actualList = getAnthropicModelList()
    expect(actualList.find((m) => m.id === 'sonnet')).toBeDefined()
    expect(actualList.find((m) => m.id === 'opus')).toBeDefined()
    expect(actualList.find((m) => m.id === 'haiku')).toBeDefined()
  })

  it('includes kiro-prefixed aliases', () => {
    const actualList = getAnthropicModelList()
    expect(actualList.find((m) => m.id === 'kiro')).toBeDefined()
    expect(actualList.find((m) => m.id === 'kiro-sonnet')).toBeDefined()
    expect(actualList.find((m) => m.id === 'kiro-opus')).toBeDefined()
    expect(actualList.find((m) => m.id === 'kiro-haiku')).toBeDefined()
  })

  it('all entries have object: "model"', () => {
    const actualList = getAnthropicModelList()
    for (const model of actualList) {
      expect(model.object).toBe('model')
    }
  })
})

describe('getAnthropicModelById', () => {
  it('returns matching model from list', () => {
    const actual = getAnthropicModelById('auto')
    expect(actual.id).toBe('auto')
    expect(actual.object).toBe('model')
    expect(actual.owned_by).toBe('kiro')
  })

  it('returns fallback entry for unknown model ID', () => {
    const actual = getAnthropicModelById('nonexistent-model')
    expect(actual.id).toBe('nonexistent-model')
    expect(actual.object).toBe('model')
    expect(actual.owned_by).toBe('kiro')
  })

  it('returns model with context_window when available', () => {
    const actual = getAnthropicModelById('claude-sonnet-4.6')
    expect(actual.context_window).toBe(1000000)
  })
})

describe('fetchKiroModels', () => {
  const originalConsoleLog = console.log
  const originalConsoleError = console.error

  beforeEach(() => {
    console.log = vi.fn()
    console.error = vi.fn()
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
  })

  it('falls back to default models when kiro-cli is not found', async () => {
    await fetchKiroModels('/nonexistent/kiro-cli')
    const actualList = getAnthropicModelList()
    expect(actualList.length).toBeGreaterThan(0)
    expect(actualList.find((m) => m.id === 'auto')).toBeDefined()
  })
})
