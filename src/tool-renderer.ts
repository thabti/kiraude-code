import * as path from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk'

interface Diff {
  readonly path: string
  readonly oldText?: string | null
  readonly newText: string
}

interface ToolContentBlock {
  readonly type: string
  readonly content?: { readonly type: string; readonly text?: string } | null
  readonly path?: string
  readonly oldText?: string | null
  readonly newText?: string
  readonly terminalId?: string
  readonly [k: string]: unknown
}

interface ToolCallStartLike {
  readonly toolCallId: string
  readonly title?: string | null
  readonly kind?: string | null
  readonly content?: ReadonlyArray<ToolContentBlock> | null
  readonly locations?: ReadonlyArray<{ readonly path: string; readonly line?: number | null }> | null
  readonly rawInput?: unknown
  readonly status?: string | null
}

interface ToolCallUpdateLike extends ToolCallStartLike {}

const ICONS: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔎',
  execute: '🖥️',
  think: '💭',
  fetch: '🌐',
  switch_mode: '🔀',
  other: '⏺',
}

const truncate = (text: string, max: number): string => {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`
}

/** Compute a minimal unified-diff-style hunk between two strings. */
const renderDiff = (path: string, oldText: string | null | undefined, newText: string): string => {
  const oldLines = (oldText ?? '').split('\n')
  const newLines = newText.split('\n')
  const lines: string[] = []
  lines.push('```diff')
  lines.push(`--- ${path}`)
  lines.push(`+++ ${path}`)
  // Naive whole-file diff: omit unchanged tail/head, mark differences.
  // Good enough for visual feedback; CC's UI only needs textual diff.
  let i = 0
  let j = 0
  const maxLines = 200
  let emitted = 0
  while ((i < oldLines.length || j < newLines.length) && emitted < maxLines) {
    const o = oldLines[i]
    const n = newLines[j]
    if (o === n) {
      lines.push(` ${o ?? ''}`)
      i++; j++
    } else {
      if (i < oldLines.length) {
        lines.push(`-${o ?? ''}`)
        i++; emitted++
      }
      if (j < newLines.length) {
        lines.push(`+${n ?? ''}`)
        j++; emitted++
      }
    }
  }
  if (i < oldLines.length || j < newLines.length) {
    lines.push(`… [diff truncated, ${oldLines.length - i} old / ${newLines.length - j} new lines remaining]`)
  }
  lines.push('```')
  return lines.join('\n')
}

const renderContentBlocks = (
  content: ReadonlyArray<ToolContentBlock> | null | undefined,
  kind: string | null | undefined,
): string => {
  if (!content || content.length === 0) return ''
  const parts: string[] = []
  for (const c of content) {
    if (c.type === 'diff' && c.path && typeof c.newText === 'string') {
      parts.push(renderDiff(c.path, c.oldText, c.newText))
      continue
    }
    if (c.type === 'terminal' && c.terminalId) {
      parts.push(`*[terminal ${c.terminalId} streaming…]*`)
      continue
    }
    if (c.type === 'content' && c.content) {
      const inner = c.content
      if (inner.type === 'text' && typeof inner.text === 'string') {
        const fence = kind === 'execute' ? 'bash' : ''
        parts.push('```' + fence)
        parts.push(truncate(inner.text, 4000))
        parts.push('```')
        continue
      }
    }
  }
  return parts.join('\n')
}

/** Make an absolute path project-relative when possible. */
const relPath = (p: string, baseDir: string): string => {
  if (!path.isAbsolute(p)) return p
  const rel = path.relative(baseDir, p)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p
  return rel || '.'
}

const formatHeader = (call: ToolCallStartLike, baseDir: string = process.cwd()): string => {
  const icon = ICONS[call.kind ?? 'other'] ?? '⏺'
  const title = call.title ?? '(tool)'
  if (call.locations && call.locations.length > 0) {
    const loc = call.locations[0]!
    const cleanPath = relPath(loc.path, baseDir)
    const where = loc.line != null ? `${cleanPath}:${loc.line}` : cleanPath
    return `${icon} ${title} — ${where}`
  }
  return `${icon} ${title}`
}

const formatRawInput = (rawInput: unknown): string => {
  if (rawInput == null) return ''
  if (typeof rawInput === 'string') return truncate(rawInput, 400)
  try {
    const json = JSON.stringify(rawInput)
    return truncate(json, 400)
  } catch {
    return ''
  }
}

interface ToolCallState {
  toolCallId: string
  blockIndex: number | null
  /** Accumulated text already written for this tool call. */
  rendered: string
  status: string
}

/**
 * Render a tool_call (start) update. Returns the full text payload for the
 * tool call's own SSE block. Caller should open a new content_block_start.
 *
 * baseDir defaults to process.cwd() — callers should pass the per-session cwd
 * when known, so paths render relative to the user's project root.
 */
const renderToolCallStart = (call: ToolCallStartLike, baseDir: string = process.cwd()): string => {
  const parts: string[] = []
  parts.push('\n' + formatHeader(call, baseDir))
  const rawIn = formatRawInput(call.rawInput)
  if (rawIn) parts.push(`> ${rawIn}`)
  const body = renderContentBlocks(call.content, call.kind)
  if (body) parts.push(body)
  return parts.join('\n') + '\n'
}

/**
 * Diff between previous render and new render — append-only delta.
 * Strategy: ACP `tool_call_update` semantics REPLACE the content array.
 * We render the full block fresh and emit only the appended portion if
 * the new render extends the old. If the new render is unrelated (rare),
 * we just send the delta as a fresh paragraph.
 */
const computeDelta = (oldRendered: string, newRendered: string): string => {
  if (newRendered.startsWith(oldRendered)) {
    return newRendered.slice(oldRendered.length)
  }
  // Replacement (e.g. terminal placeholder → final output). Re-emit a separator + new render.
  return `\n${newRendered}`
}

const renderToolCallUpdate = (
  prev: ToolCallState,
  update: ToolCallUpdateLike,
  baseDir: string = process.cwd(),
): { delta: string; rendered: string; status: string } => {
  const merged: ToolCallStartLike = {
    toolCallId: update.toolCallId,
    title: update.title ?? null,
    kind: update.kind ?? null,
    content: update.content ?? null,
    locations: update.locations ?? null,
    rawInput: update.rawInput,
    status: update.status ?? prev.status,
  }
  const newRendered = renderToolCallStart(merged, baseDir)
  const delta = computeDelta(prev.rendered, newRendered)
  const status = update.status ?? prev.status
  let rendered = prev.rendered + delta
  // If status finalized, append marker once.
  if (
    (status === 'completed' || status === 'failed') &&
    prev.status !== status
  ) {
    const marker = status === 'failed' ? '  ✗ failed\n' : ''
    if (marker) rendered += marker
    return { delta: delta + marker, rendered, status }
  }
  return { delta, rendered, status }
}

/** Render an ACP `plan` SessionUpdate as a markdown todo list. */
const renderPlan = (entries: ReadonlyArray<{ content: string; status: string; priority?: string }>): string => {
  if (!entries || entries.length === 0) return ''
  const lines: string[] = []
  lines.push('\n📋 **Plan**')
  for (const e of entries) {
    const box = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]'
    lines.push(`- ${box} ${e.content}`)
  }
  return lines.join('\n') + '\n'
}

const isToolCallStart = (update: SessionUpdate): update is SessionUpdate & ToolCallStartLike =>
  update.sessionUpdate === 'tool_call'

const isToolCallUpdate = (update: SessionUpdate): update is SessionUpdate & ToolCallUpdateLike =>
  update.sessionUpdate === 'tool_call_update'

export {
  renderToolCallStart,
  renderToolCallUpdate,
  renderPlan,
  renderDiff,
  isToolCallStart,
  isToolCallUpdate,
  formatHeader,
}
export type { ToolCallStartLike, ToolCallUpdateLike, ToolCallState, ToolContentBlock }
