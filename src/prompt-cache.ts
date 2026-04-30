import crypto from 'node:crypto'
import type { AnthropicRequest, AnthropicMessage } from './translator.js'

interface CacheKey {
  /** Stable hash of system + tools + all messages up to (and including) the
   *  last cache_control marker, or null if no marker found. */
  readonly prefixHash: string | null
  /** Approximate token count of the cached prefix (chars/4). */
  readonly prefixTokens: number
}

const CHARS_PER_TOKEN = 4

const stringifyContent = (content: AnthropicMessage['content']): string => {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool_result') {
      parts.push(typeof block.content === 'string' ? block.content : block.content.map((c) => c.text).join('\n'))
    } else if (block.type === 'tool_use') {
      parts.push(block.name + JSON.stringify(block.input))
    }
  }
  return parts.join('\n')
}

const hasCacheControl = (block: unknown): boolean => {
  if (!block || typeof block !== 'object') return false
  return 'cache_control' in (block as Record<string, unknown>) &&
    (block as Record<string, unknown>).cache_control != null
}

const messageHasCacheMarker = (msg: AnthropicMessage): boolean => {
  if (typeof msg.content === 'string') return false
  return msg.content.some(hasCacheControl)
}

/**
 * Compute prefix hash & approximate token count up to the last cache_control
 * marker. Returns null if no marker found (cache disabled for this request).
 */
export const computePrefixCacheKey = (request: AnthropicRequest): CacheKey => {
  let lastMarkedIdx = -1
  if (Array.isArray(request.system)) {
    if (request.system.some(hasCacheControl)) {
      lastMarkedIdx = -1 // system-only marker is a virtual idx of -1
    }
  }
  for (let i = 0; i < request.messages.length; i++) {
    if (messageHasCacheMarker(request.messages[i]!)) {
      lastMarkedIdx = i
    }
  }
  const systemMarked = Array.isArray(request.system) && request.system.some(hasCacheControl)
  if (lastMarkedIdx === -1 && !systemMarked) {
    return { prefixHash: null, prefixTokens: 0 }
  }
  const hash = crypto.createHash('sha256')
  let chars = 0
  if (request.system) {
    const systemText = typeof request.system === 'string'
      ? request.system
      : request.system.map((b) => b.text).join('\n')
    hash.update('SYS:')
    hash.update(systemText)
    chars += systemText.length
  }
  if (request.tools) {
    for (const t of request.tools) {
      if (!t.name) continue
      hash.update('TOOL:')
      hash.update(t.name)
      if (t.description) hash.update(t.description)
    }
  }
  for (let i = 0; i <= lastMarkedIdx; i++) {
    const m = request.messages[i]!
    const text = stringifyContent(m.content)
    hash.update(`M${i}:${m.role}:`)
    hash.update(text)
    chars += text.length
  }
  return {
    prefixHash: hash.digest('hex'),
    prefixTokens: Math.ceil(chars / CHARS_PER_TOKEN),
  }
}

interface CacheEntry {
  prefixHash: string
  acpSessionId: string
  workerId: number
  prefixTokens: number
  lastAccessedAt: number
  hits: number
}

class PromptCacheRegistry {
  private readonly entries: Map<string, CacheEntry> = new Map()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = opts?.maxEntries ?? 256
    this.ttlMs = opts?.ttlMs ?? 60 * 60 * 1000 // 1h, matches Anthropic ephemeral cache
  }

  lookup(prefixHash: string): CacheEntry | null {
    const entry = this.entries.get(prefixHash)
    if (!entry) return null
    if (Date.now() - entry.lastAccessedAt > this.ttlMs) {
      this.entries.delete(prefixHash)
      return null
    }
    entry.lastAccessedAt = Date.now()
    entry.hits++
    return entry
  }

  record(prefixHash: string, acpSessionId: string, workerId: number, prefixTokens: number): void {
    if (this.entries.size >= this.maxEntries) {
      let oldestKey: string | null = null
      let oldestAt = Infinity
      for (const [k, e] of this.entries) {
        if (e.lastAccessedAt < oldestAt) {
          oldestAt = e.lastAccessedAt
          oldestKey = k
        }
      }
      if (oldestKey) this.entries.delete(oldestKey)
    }
    this.entries.set(prefixHash, {
      prefixHash,
      acpSessionId,
      workerId,
      prefixTokens,
      lastAccessedAt: Date.now(),
      hits: 0,
    })
  }

  invalidateSession(acpSessionId: string): void {
    for (const [k, e] of this.entries) {
      if (e.acpSessionId === acpSessionId) this.entries.delete(k)
    }
  }

  invalidateWorker(workerId: number): void {
    for (const [k, e] of this.entries) {
      if (e.workerId === workerId) this.entries.delete(k)
    }
  }

  size(): number {
    return this.entries.size
  }
}

export default PromptCacheRegistry
export type { CacheKey, CacheEntry }
