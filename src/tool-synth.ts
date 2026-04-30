import crypto from 'node:crypto'
import type { ToolCallStartLike, ToolContentBlock } from './tool-renderer.js'

/**
 * Synthesizes Anthropic tool_use blocks from ACP tool_call updates.
 *
 * Names are PREFIXED with `kiro_` so CC won't try to execute them
 * (they're not registered in CC's tool list). CC will display the input
 * JSON as a tool_use block, future CC versions may render rich diffs.
 *
 * Schemas match CC's canonical tool input shapes (file_path, old_string,
 * new_string, command, etc.) so a future CC release that strips the prefix
 * can render natively without proxy changes.
 */

interface SynthesizedToolUse {
  readonly toolUseId: string
  readonly name: string
  readonly input: Record<string, unknown>
}

const EMULATE_DEFAULT = true

/** Read EMULATE_CC_TOOLS env. Defaults to true unless explicitly "false". */
const isEmulateEnabled = (): boolean => {
  const v = process.env['EMULATE_CC_TOOLS']
  if (v === undefined) return EMULATE_DEFAULT
  return v.toLowerCase() !== 'false'
}

const NAME_BY_KIND: Record<string, string> = {
  edit: 'kiro_Edit',
  delete: 'kiro_Edit',
  move: 'kiro_Edit',
  execute: 'kiro_Bash',
  read: 'kiro_Read',
  search: 'kiro_Grep',
  fetch: 'kiro_Fetch',
  think: 'kiro_Think',
  switch_mode: 'kiro_SwitchMode',
  other: 'kiro_Tool',
}

/** Synthesize input record from a tool_call's kind + content + locations. */
const synthesizeInput = (call: ToolCallStartLike): Record<string, unknown> => {
  const kind = call.kind ?? 'other'
  const content = call.content ?? []
  const locations = call.locations ?? []
  const rawInput = (call.rawInput && typeof call.rawInput === 'object')
    ? call.rawInput as Record<string, unknown>
    : {}

  if (kind === 'edit' || kind === 'delete' || kind === 'move') {
    const diff = findDiff(content)
    if (diff) {
      const isWrite = (diff.oldText == null || diff.oldText === '') && diff.newText.length > 0
      if (isWrite) {
        return { file_path: diff.path, content: diff.newText }
      }
      return {
        file_path: diff.path,
        old_string: diff.oldText ?? '',
        new_string: diff.newText,
      }
    }
    if (locations.length > 0) {
      return { file_path: locations[0]!.path, ...rawInput }
    }
    return rawInput
  }

  if (kind === 'execute') {
    if (typeof rawInput['command'] === 'string') {
      return { command: rawInput['command'], description: call.title ?? '' }
    }
    const text = findText(content)
    if (text) return { command: text, description: call.title ?? '' }
    return { command: call.title ?? '', description: '' }
  }

  if (kind === 'read') {
    if (locations.length > 0) {
      const loc = locations[0]!
      return { file_path: loc.path, ...(loc.line != null ? { offset: loc.line } : {}) }
    }
    if (typeof rawInput['path'] === 'string') return { file_path: rawInput['path'] }
    if (typeof rawInput['file_path'] === 'string') return rawInput
    return rawInput
  }

  if (kind === 'search') {
    if (typeof rawInput['pattern'] === 'string') {
      const out: Record<string, unknown> = { pattern: rawInput['pattern'] }
      if (typeof rawInput['path'] === 'string') out['path'] = rawInput['path']
      return out
    }
    if (locations.length > 0) {
      return { path: locations[0]!.path, ...rawInput }
    }
    return rawInput
  }

  // Fallback: pass through rawInput verbatim with a title hint.
  return { _title: call.title ?? '', ...rawInput }
}

/**
 * Derive a stable Anthropic tool_use.id from an ACP toolCallId.
 * Same kiro toolCallId always maps to the same tool_use.id, so subsequent
 * tool_call_update emissions reuse the same id (per Anthropic spec, the id
 * pairs tool_use ↔ tool_result across turns).
 */
const stableToolUseId = (acpToolCallId: string): string => {
  const hash = crypto.createHash('sha256').update(acpToolCallId).digest('hex')
  return `toolu_${hash.slice(0, 24)}`
}

/** Build a SynthesizedToolUse for a tool_call (returns null if disabled). */
const synthesizeToolUse = (call: ToolCallStartLike, toolUseId?: string): SynthesizedToolUse | null => {
  if (!isEmulateEnabled()) return null
  const name = NAME_BY_KIND[call.kind ?? 'other'] ?? 'kiro_Tool'
  const input = synthesizeInput(call)
  const id = toolUseId ?? stableToolUseId(call.toolCallId)
  return { toolUseId: id, name, input }
}

const findDiff = (content: ReadonlyArray<ToolContentBlock>): { path: string; oldText: string | null; newText: string } | null => {
  for (const c of content) {
    if (c.type === 'diff' && c.path && typeof c.newText === 'string') {
      return { path: c.path, oldText: (c.oldText ?? null) as string | null, newText: c.newText }
    }
  }
  return null
}

const findText = (content: ReadonlyArray<ToolContentBlock>): string | null => {
  for (const c of content) {
    if (c.type === 'content' && c.content && c.content.type === 'text' && typeof c.content.text === 'string') {
      return c.content.text
    }
  }
  return null
}

export { synthesizeToolUse, synthesizeInput, isEmulateEnabled, NAME_BY_KIND, stableToolUseId }
export type { SynthesizedToolUse }
