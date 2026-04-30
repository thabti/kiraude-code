import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadMcpServers } from './mcp-config.js'

const restore = (key: string, prev: string | undefined): void => {
  if (prev === undefined) delete process.env[key]
  else process.env[key] = prev
}

describe('loadMcpServers', () => {
  let prevJson: string | undefined
  let prevFile: string | undefined
  let tmpFile: string | null = null

  beforeEach(() => {
    prevJson = process.env['KIRO_MCP_SERVERS_JSON']
    prevFile = process.env['KIRO_MCP_SERVERS_FILE']
    delete process.env['KIRO_MCP_SERVERS_JSON']
    delete process.env['KIRO_MCP_SERVERS_FILE']
  })

  afterEach(() => {
    restore('KIRO_MCP_SERVERS_JSON', prevJson)
    restore('KIRO_MCP_SERVERS_FILE', prevFile)
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile)
      tmpFile = null
    }
  })

  it('returns empty array when no env set', () => {
    expect(loadMcpServers()).toEqual([])
  })

  it('parses JSON env var', () => {
    process.env['KIRO_MCP_SERVERS_JSON'] = JSON.stringify([
      { type: 'http', name: 'web', url: 'https://example.com', headers: [] },
    ])
    const result = loadMcpServers()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'http', name: 'web', url: 'https://example.com' })
  })

  it('parses stdio config without type field', () => {
    process.env['KIRO_MCP_SERVERS_JSON'] = JSON.stringify([
      { name: 'local', command: '/usr/bin/mcp', args: ['--port', '3000'] },
    ])
    const result = loadMcpServers()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ name: 'local', command: '/usr/bin/mcp', args: ['--port', '3000'] })
  })

  it('reads from file when KIRO_MCP_SERVERS_FILE set', () => {
    tmpFile = path.join(os.tmpdir(), `mcp-test-${Date.now()}.json`)
    fs.writeFileSync(tmpFile, JSON.stringify([
      { type: 'sse', name: 'sse-server', url: 'https://sse.example.com', headers: [] },
    ]))
    process.env['KIRO_MCP_SERVERS_FILE'] = tmpFile
    const result = loadMcpServers()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'sse', name: 'sse-server' })
  })

  it('skips entries missing required fields', () => {
    process.env['KIRO_MCP_SERVERS_JSON'] = JSON.stringify([
      { type: 'http' }, // no name, no url
      { name: 'good', command: '/bin/foo' },
    ])
    const result = loadMcpServers()
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('good')
  })

  it('returns empty on invalid JSON', () => {
    process.env['KIRO_MCP_SERVERS_JSON'] = 'not json'
    expect(loadMcpServers()).toEqual([])
  })

  it('returns empty on non-array JSON', () => {
    process.env['KIRO_MCP_SERVERS_JSON'] = JSON.stringify({ foo: 'bar' })
    expect(loadMcpServers()).toEqual([])
  })
})
