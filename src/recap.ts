import * as path from 'node:path'
import type { AnthropicTool } from './translator.js'
import type { ToolCallState } from './tool-renderer.js'

interface PlanEntry {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed' | string
  readonly priority?: string
}

interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
  readonly activeForm: string
}

/** Does the client have the TodoWrite tool registered? */
const clientHasTodoWrite = (tools: ReadonlyArray<AnthropicTool> | undefined): boolean => {
  if (!tools) return false
  return tools.some((t) => t.name === 'TodoWrite')
}

/**
 * Map ACP plan entries → TodoWrite tool input. Synthesizes activeForm from
 * content if not provided (kiro doesn't carry activeForm).
 */
const planToTodos = (entries: ReadonlyArray<PlanEntry>): { todos: TodoItem[] } => {
  const todos: TodoItem[] = entries.map((e) => {
    const status: TodoItem['status'] =
      e.status === 'completed' ? 'completed' :
      e.status === 'in_progress' ? 'in_progress' :
      'pending'
    return {
      content: e.content,
      status,
      activeForm: deriveActiveForm(e.content),
    }
  })
  return { todos }
}

/**
 * Best-effort activeForm: convert imperative ("Fix bug") → present-continuous
 * ("Fixing bug"). For statements that already look continuous, return as-is.
 * Preserves the original capitalization of the first letter.
 */
const deriveActiveForm = (content: string): string => {
  const trimmed = content.trim()
  if (trimmed.length === 0) return 'Working'
  if (/^\w+ing\b/i.test(trimmed)) return trimmed
  const firstSpace = trimmed.indexOf(' ')
  const verb = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace)
  const ing = toIng(verb)
  // Preserve case of first letter from input.
  const firstChar = verb.charAt(0)
  if (firstChar && firstChar === firstChar.toUpperCase()) {
    return ing.charAt(0).toUpperCase() + ing.slice(1) + rest
  }
  return ing + rest
}

/** Converts a verb to its -ing form. Operates on lowercase. */
const toIng = (verb: string): string => {
  const v = verb.toLowerCase()
  if (v.endsWith('ie')) return v.slice(0, -2) + 'ying'
  if (v.endsWith('e') && !v.endsWith('ee')) return v.slice(0, -1) + 'ing'
  // Doubling rule: CVC pattern (one vowel between two single consonants).
  // Examples: run→running, ship→shipping, but NOT fix→fixxing (x rare),
  // NOT make→makking (ends in e, handled above).
  if (
    v.length >= 3 &&
    /[bcdfghjklmnprstvwz]$/.test(v) &&
    /[aeiou]/.test(v.charAt(v.length - 2)) &&
    /[bcdfghjklmnpqrstvwz]/.test(v.charAt(v.length - 3))
  ) {
    return v + v.slice(-1) + 'ing'
  }
  return v + 'ing'
}

interface RecapOptions {
  /** Base directory used to render absolute paths as relative. Defaults to process.cwd(). */
  readonly baseDir?: string
}

/**
 * Build a "What changed" recap from the tracked tool calls + plan state.
 * Returns empty string when no tool activity.
 */
const buildRecap = (
  toolCalls: ReadonlyMap<string, ToolCallState>,
  hasPlan: boolean,
  options?: RecapOptions,
): string => {
  if (toolCalls.size === 0 && !hasPlan) return ''
  const baseDir = options?.baseDir ?? process.cwd()
  const lines: string[] = []
  lines.push('\n---')
  lines.push('## What changed')
  if (toolCalls.size === 0 && hasPlan) {
    lines.push('- Plan updated (see above).')
    return lines.join('\n') + '\n'
  }
  let i = 0
  for (const state of toolCalls.values()) {
    i++
    const summary = summarizeToolCall(state, baseDir)
    lines.push(`${i}. ${summary}`)
  }
  if (hasPlan) {
    lines.push(`${i + 1}. Plan updated (see above).`)
  }
  return lines.join('\n') + '\n'
}

/** Make absolute paths project-relative; leave non-paths and outside-of-base alone. */
const relativizePath = (raw: string, baseDir: string): string => {
  const trimmed = raw.trim()
  // Split off optional :line suffix.
  const lineMatch = trimmed.match(/^(.+?)(:\d+(?::\d+)?)?$/)
  const filePart = lineMatch?.[1] ?? trimmed
  const lineSuffix = lineMatch?.[2] ?? ''
  if (!path.isAbsolute(filePart)) return trimmed
  const rel = path.relative(baseDir, filePart)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return trimmed
  return (rel || '.') + lineSuffix
}

/** One-liner per tool call: extract title + first location, with status icon. */
const summarizeToolCall = (state: ToolCallState, baseDir: string = process.cwd()): string => {
  const meta = parseRenderedMeta(state.rendered)
  const statusIcon = state.status === 'completed' ? '✅'
    : state.status === 'failed' ? '❌'
    : state.status === 'in_progress' ? '🔄'
    : '⏳'
  const displayPath = meta.path ? relativizePath(meta.path, baseDir) : null
  const where = displayPath ? ` — \`${displayPath}\`` : ''
  return `${statusIcon} **${meta.title}**${where}`
}

/** Pull title + path from the first line of a rendered tool call block. */
const parseRenderedMeta = (rendered: string): { title: string; path: string | null } => {
  const firstLine = rendered.split('\n').find((l) => l.trim().length > 0) ?? ''
  // formatHeader output: `${icon} ${title}` or `${icon} ${title} — ${where}`
  const cleaned = firstLine.replace(/^[^A-Za-z0-9`]+/u, '').trim()
  const dashIdx = cleaned.indexOf(' — ')
  if (dashIdx !== -1) {
    return {
      title: cleaned.slice(0, dashIdx).trim(),
      path: cleaned.slice(dashIdx + 3).trim() || null,
    }
  }
  return { title: cleaned, path: null }
}

export {
  clientHasTodoWrite,
  planToTodos,
  buildRecap,
  summarizeToolCall,
  parseRenderedMeta,
  deriveActiveForm,
  relativizePath,
}
export type { PlanEntry, TodoItem, RecapOptions }
