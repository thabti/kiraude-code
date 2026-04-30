import type { Response } from 'express'

interface SseUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens?: number
  readonly cache_read_input_tokens?: number
}

interface ContentBlockStart {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
}

const sendSseEvent = (res: Response, eventType: string, data: unknown): void => {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
}

class StreamingResponseBuilder {
  private blockIndex = 0

  getBlockIndex(): number {
    return this.blockIndex
  }

  incrementBlockIndex(): number {
    return this.blockIndex++
  }

  sendMessageStart(res: Response, messageId: string, model: string): void {
    sendSseEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  sendContentBlockStart(res: Response, index: number, block: ContentBlockStart): void {
    sendSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: block,
    })
  }

  /**
   * Open a tool_use content block. Anthropic spec: content_block_start with
   * empty input ({}), then content_block_delta input_json_delta events stream
   * the JSON, terminated by content_block_stop.
   */
  sendToolUseStart(res: Response, index: number, toolUseId: string, name: string): void {
    sendSseEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: toolUseId, name, input: {} },
    })
  }

  sendTextDelta(res: Response, index: number, text: string): void {
    sendSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    })
  }

  sendThinkingDelta(res: Response, index: number, thinking: string): void {
    sendSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'thinking_delta', thinking },
    })
  }

  sendSignatureDelta(res: Response, index: number, signature: string): void {
    sendSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'signature_delta', signature },
    })
  }

  sendToolUseDelta(res: Response, index: number, partialJson: string): void {
    sendSseEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    })
  }

  sendContentBlockStop(res: Response, index: number): void {
    sendSseEvent(res, 'content_block_stop', {
      type: 'content_block_stop',
      index,
    })
  }

  sendMessageDelta(res: Response, stopReason: string, usage: SseUsage): void {
    sendSseEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    })
  }

  sendMessageStop(res: Response): void {
    sendSseEvent(res, 'message_stop', { type: 'message_stop' })
  }

  sendPing(res: Response): void {
    sendSseEvent(res, 'ping', { type: 'ping' })
  }
}

export { sendSseEvent, StreamingResponseBuilder }
export type { SseUsage, ContentBlockStart }
