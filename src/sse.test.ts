import { describe, it, expect, vi } from 'vitest'
import { sendSseEvent, StreamingResponseBuilder } from './sse.js'
import type { Response } from 'express'

const createMockResponse = (): Response & { written: string[] } => {
  const written: string[] = []
  return {
    written,
    write: vi.fn((chunk: string) => { written.push(chunk); return true }),
  } as unknown as Response & { written: string[] }
}

describe('sendSseEvent', () => {
  it('writes event and data lines', () => {
    const mockRes = createMockResponse()
    sendSseEvent(mockRes, 'ping', { type: 'ping' })
    expect(mockRes.write).toHaveBeenCalledWith(
      'event: ping\ndata: {"type":"ping"}\n\n',
    )
  })
})

describe('StreamingResponseBuilder', () => {
  it('starts block index at 0', () => {
    const builder = new StreamingResponseBuilder()
    expect(builder.getBlockIndex()).toBe(0)
  })

  it('increments block index', () => {
    const builder = new StreamingResponseBuilder()
    expect(builder.incrementBlockIndex()).toBe(0)
    expect(builder.incrementBlockIndex()).toBe(1)
    expect(builder.getBlockIndex()).toBe(2)
  })

  it('sends message_start event', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendMessageStart(mockRes, 'msg_123', 'kiro')
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.type).toBe('message_start')
    expect(actualData.message.id).toBe('msg_123')
    expect(actualData.message.model).toBe('kiro')
    expect(actualData.message.role).toBe('assistant')
  })

  it('sends content_block_start event', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendContentBlockStart(mockRes, 0, { type: 'text', text: '' })
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.type).toBe('content_block_start')
    expect(actualData.index).toBe(0)
    expect(actualData.content_block.type).toBe('text')
  })

  it('sends text_delta event', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendTextDelta(mockRes, 0, 'hello')
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.type).toBe('content_block_delta')
    expect(actualData.delta.type).toBe('text_delta')
    expect(actualData.delta.text).toBe('hello')
  })

  it('sends input_json_delta for tool use', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendToolUseDelta(mockRes, 1, '{"key":"val"}')
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.delta.type).toBe('input_json_delta')
    expect(actualData.delta.partial_json).toBe('{"key":"val"}')
  })

  it('sends content_block_stop event', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendContentBlockStop(mockRes, 0)
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.type).toBe('content_block_stop')
    expect(actualData.index).toBe(0)
  })

  it('sends message_delta with stop reason and usage', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendMessageDelta(mockRes, 'end_turn', { input_tokens: 10, output_tokens: 5 })
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.type).toBe('message_delta')
    expect(actualData.delta.stop_reason).toBe('end_turn')
    expect(actualData.usage.input_tokens).toBe(10)
  })

  it('sends message_stop event', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendMessageStop(mockRes)
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.type).toBe('message_stop')
  })

  it('sends ping event', () => {
    const mockRes = createMockResponse()
    const builder = new StreamingResponseBuilder()
    builder.sendPing(mockRes)
    const actualData = JSON.parse(mockRes.written[0]!.split('data: ')[1]!)
    expect(actualData.type).toBe('ping')
  })
})
