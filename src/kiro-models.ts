import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface KiroModel {
  model_name: string
  description: string
  model_id: string
  context_window_tokens: number
  rate_multiplier: number
  rate_unit: string
}

interface KiroModelsResponse {
  models: KiroModel[]
  default_model: string
}

interface AnthropicModelEntry {
  id: string
  object: 'model'
  created: number
  owned_by: string
  context_window?: number
  description?: string
}

// Claude Code model alias → Kiro model_id prefix matching
const ALIAS_MAP: Record<string, string> = {
  // Claude Code short aliases
  'sonnet': 'claude-sonnet-4.6',
  'opus': 'claude-opus-4.6',
  'haiku': 'claude-haiku-4.5',
  // Anthropic-style IDs with dashes (Claude Code sends these)
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-opus-4-7': 'claude-opus-4.6',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-1': 'claude-opus-4.6',
  'claude-opus-4': 'claude-opus-4.6',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  // kiro-* aliases
  'kiro': 'auto',
  'kiro-opus': 'claude-opus-4.6',
  'kiro-sonnet': 'claude-sonnet-4.6',
  'kiro-haiku': 'claude-haiku-4.5',
}

const MODEL_CREATED_TIMESTAMP = 1700000000

let cachedModels: AnthropicModelEntry[] | null = null
let cachedKiroModels: KiroModel[] | null = null
let defaultKiroModelId = 'auto'

export async function fetchKiroModels(kiroCli: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync(kiroCli, ['chat', '--list-models', '--format', 'json'])
    const parsed: KiroModelsResponse = JSON.parse(stdout)
    cachedKiroModels = parsed.models
    defaultKiroModelId = parsed.default_model ?? 'auto'
    cachedModels = buildAnthropicModelList(parsed.models)
    console.log(`[models] loaded ${parsed.models.length} Kiro models, default: ${defaultKiroModelId}`)
  } catch (err) {
    console.error(`[models] failed to fetch Kiro models: ${err}. Using fallback list.`)
    cachedModels = FALLBACK_MODELS
    cachedKiroModels = null
  }
}

function buildAnthropicModelList(kiroModels: KiroModel[]): AnthropicModelEntry[] {
  const entries: AnthropicModelEntry[] = []

  for (const m of kiroModels) {
    // Primary entry using Kiro's model_id (dot notation, e.g. claude-sonnet-4.6)
    entries.push({
      id: m.model_id,
      object: 'model',
      created: MODEL_CREATED_TIMESTAMP,
      owned_by: 'kiro',
      context_window: m.context_window_tokens,
      description: m.description,
    })
    // Alias entry with dashes for Claude Code compatibility (claude-sonnet-4-6)
    const dashId = m.model_id.replace(/\./g, '-')
    if (dashId !== m.model_id) {
      entries.push({
        id: dashId,
        object: 'model',
        created: MODEL_CREATED_TIMESTAMP,
        owned_by: 'kiro',
        context_window: m.context_window_tokens,
        description: m.description,
      })
    }
  }

  // Add short aliases Claude Code uses in its model picker
  const aliasEntries: AnthropicModelEntry[] = [
    { id: 'kiro',        object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Kiro default model (auto)' },
    { id: 'kiro-sonnet', object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Kiro Sonnet model' },
    { id: 'kiro-opus',   object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Kiro Opus model' },
    { id: 'kiro-haiku',  object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Kiro Haiku model' },
    { id: 'sonnet',      object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Sonnet alias → claude-sonnet-4.6' },
    { id: 'opus',        object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Opus alias → claude-opus-4.6' },
    { id: 'haiku',       object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Haiku alias → claude-haiku-4.5' },
  ]

  return [...entries, ...aliasEntries]
}

/**
 * Resolve any model ID Claude Code might send → Kiro model_id.
 * Falls back to the Kiro default ('auto') if no mapping found.
 */
export function resolveKiroModelId(requestedModel: string): string {
  // Direct alias lookup
  if (ALIAS_MAP[requestedModel]) return ALIAS_MAP[requestedModel]!

  // Dot-notation exact match in cached Kiro models
  if (cachedKiroModels) {
    const exact = cachedKiroModels.find((m) => m.model_id === requestedModel || m.model_name === requestedModel)
    if (exact) return exact.model_id

    // Dash → dot conversion: claude-sonnet-4-6 → try claude-sonnet-4.6
    const dotVersion = requestedModel.replace(/-(\d+)$/, '.$1').replace(/-(\d+)-(\d+)$/, '.$1.$2')
    const dotMatch = cachedKiroModels.find((m) => m.model_id === dotVersion)
    if (dotMatch) return dotMatch.model_id
  }

  // If it looks like it's already a valid Kiro model_id, use it
  if (requestedModel.includes('.') || requestedModel === 'auto') return requestedModel

  return defaultKiroModelId
}

export function getAnthropicModelList(): AnthropicModelEntry[] {
  return cachedModels ?? FALLBACK_MODELS
}

export function getAnthropicModelById(id: string): AnthropicModelEntry {
  const list = getAnthropicModelList()
  return list.find((m) => m.id === id) ?? {
    id,
    object: 'model',
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: 'kiro',
  }
}

// Static fallback if kiro-cli is unavailable at startup
const FALLBACK_MODELS: AnthropicModelEntry[] = [
  { id: 'auto',               object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', description: 'Models chosen by task for optimal usage' },
  { id: 'claude-sonnet-4.6',  object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', context_window: 1000000 },
  { id: 'claude-sonnet-4-6',  object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', context_window: 1000000 },
  { id: 'claude-opus-4.6',    object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', context_window: 1000000 },
  { id: 'claude-opus-4-6',    object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro', context_window: 1000000 },
  { id: 'claude-haiku-4.5',   object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'claude-haiku-4-5',   object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'kiro',               object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'kiro-sonnet',        object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'kiro-opus',          object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'kiro-haiku',         object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'sonnet',             object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'opus',               object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
  { id: 'haiku',              object: 'model', created: MODEL_CREATED_TIMESTAMP, owned_by: 'kiro' },
]
