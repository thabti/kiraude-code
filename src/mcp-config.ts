import * as fs from 'node:fs'
import type { McpServer } from '@agentclientprotocol/sdk'

/**
 * Load MCP server configuration for kiro ACP sessions.
 * Sources (in order):
 *   1. KIRO_MCP_SERVERS_JSON env var (raw JSON array)
 *   2. KIRO_MCP_SERVERS_FILE env var (path to JSON file)
 * Returns [] if no config provided.
 */
export const loadMcpServers = (): Array<McpServer> => {
  const json = process.env['KIRO_MCP_SERVERS_JSON']
  if (json && json.trim().length > 0) {
    try {
      const parsed = JSON.parse(json)
      return validateMcpServers(parsed)
    } catch (err) {
      console.error(`[mcp] failed to parse KIRO_MCP_SERVERS_JSON: ${err}`)
    }
  }
  const file = process.env['KIRO_MCP_SERVERS_FILE']
  if (file && file.trim().length > 0) {
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(raw)
      return validateMcpServers(parsed)
    } catch (err) {
      console.error(`[mcp] failed to read ${file}: ${err}`)
    }
  }
  return []
}

const validateMcpServers = (data: unknown): Array<McpServer> => {
  if (!Array.isArray(data)) {
    console.error('[mcp] config must be an array')
    return []
  }
  const out: Array<McpServer> = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e['name'] !== 'string') continue
    if (e['type'] === 'http' && typeof e['url'] === 'string') {
      out.push({
        type: 'http',
        name: e['name'],
        url: e['url'],
        headers: Array.isArray(e['headers']) ? (e['headers'] as Array<{ name: string; value: string }>) : [],
      })
      continue
    }
    if (e['type'] === 'sse' && typeof e['url'] === 'string') {
      out.push({
        type: 'sse',
        name: e['name'],
        url: e['url'],
        headers: Array.isArray(e['headers']) ? (e['headers'] as Array<{ name: string; value: string }>) : [],
      })
      continue
    }
    if (typeof e['command'] === 'string') {
      out.push({
        name: e['name'],
        command: e['command'],
        args: Array.isArray(e['args']) ? (e['args'] as string[]) : [],
        env: Array.isArray(e['env']) ? (e['env'] as Array<{ name: string; value: string }>) : [],
      })
    }
  }
  return out
}
