import type { AnthropicTool, AnthropicRequest } from './translator.js'

const PERSONA_HEADER = `<<system_instructions>>
You are running inside Claude Code via the Kiro CLI proxy. Behave like Claude Code.

Output rules:
- Keep prose terse. Let tool actions speak.
- When you read/edit/run, prefer using the tools the client provided over describing what you would do.
- If the client provides a tool result, treat it as ground truth — do not re-execute the same tool unless the result is incomplete.
- For file edits, produce a unified diff via the Edit tool when possible.
- For multi-step work, maintain a live plan; emit plan updates as you make progress (pending → in_progress → completed). The proxy will surface this as a TodoWrite checklist in the client UI.
- For shell commands, use the Bash tool.
- End-of-turn summary: when the turn included edits or commands, end with ONE sentence describing the outcome (what changed and the immediate next step). The proxy appends a deterministic "What changed" recap underneath — do not duplicate it.

The user is communicating through an Anthropic Messages API client. Tool calls you emit will be executed by the client and the result fed back to you in the next turn as a tool_result block. Trust those results.
<<end_system_instructions>>
`

const renderToolSchemas = (tools: ReadonlyArray<AnthropicTool>): string => {
  const lines: string[] = []
  for (const tool of tools) {
    if (!tool.name) continue
    lines.push(`### ${tool.name}`)
    if (tool.description) {
      const desc = tool.description.length > 600
        ? tool.description.slice(0, 600) + '…'
        : tool.description
      lines.push(desc)
    }
    if (tool.input_schema) {
      lines.push('```json')
      lines.push(JSON.stringify(tool.input_schema, null, 2))
      lines.push('```')
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Build the persona/instructions block prepended to a NEW kiro session's
 * first prompt. Combines:
 *   - persona header ("act like CC")
 *   - the client's system prompt verbatim
 *   - the client's tool catalog with full input_schema JSON
 *
 * Skip on existing sessions — kiro retains prior context.
 */
const buildPersonaPrefix = (request: AnthropicRequest, systemText: string | null): string => {
  const sections: string[] = [PERSONA_HEADER]
  if (systemText && systemText.length > 0) {
    sections.push('## Client System Prompt')
    sections.push(systemText)
    sections.push('')
  }
  if (request.tools && request.tools.length > 0) {
    const userTools = request.tools.filter((t) => t.name)
    if (userTools.length > 0) {
      sections.push('## Available Client Tools')
      sections.push(
        'These tools are executed by the client. Emit a tool_use to invoke them. ' +
        'Do not attempt them yourself when the client tool covers the task.',
      )
      sections.push('')
      sections.push(renderToolSchemas(userTools))
    }
  }
  return sections.join('\n')
}

export { buildPersonaPrefix, PERSONA_HEADER }
