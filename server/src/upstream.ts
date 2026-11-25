import { config } from './config.js'
import { streamOpenAIChat } from './adapters/openai-chat.js'
import { streamOpenAIResponses } from './adapters/openai-responses.js'

/**
 * 上游模型调用层：Agent 循环内部统一使用 Anthropic 消息/事件形态，
 * 由协议适配器负责「Anthropic 形态 ⇄ 各厂商协议」的双向转换。
 * 协议与端点在 .env 配置：MODEL_PROTOCOL + MODEL_ENDPOINT。
 */

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/** Agent 内部的统一事件（Anthropic 流式事件形态） */
export type StreamEvent = Record<string, unknown> & { type: string }

/** Agent 内部的统一请求（Anthropic Messages 形态） */
export type UpstreamRequest = {
  model: string
  system: string
  messages: { role: 'user' | 'assistant'; content: unknown }[]
  thinking?: Record<string, unknown>
  tools?: unknown[]
  max_tokens?: number
}

/** 简化版 SSE 解析：按空行分帧，取 event 与 data 字段 */
export const parseSseFrames = (
  chunk: string,
  buffer: { text: string }
): { event: string; data: string }[] => {
  buffer.text += chunk
  const frames: { event: string; data: string }[] = []
  const parts = buffer.text.split(/\r?\n\r?\n/)
  buffer.text = parts.pop() ?? ''
  for (const part of parts) {
    let event = 'message'
    let data = ''
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith(':')) {
        continue
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5).trim()
      }
    }
    if (data) {
      frames.push({ event, data })
    }
  }
  return frames
}

/** 发起流式 POST，逐帧回调 data 文本；非 2xx 抛 UpstreamError */
export const postSse = async (
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  onFrame: (data: string) => void
): Promise<void> => {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new UpstreamError(502, `无法连接模型上游（${url}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || response.statusText
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string }
      const inner = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
      if (inner) {
        message = inner
      }
    } catch {
      // 非 JSON 错误体直接展示原文
    }
    throw new UpstreamError(response.status, message)
  }
  if (!response.body) {
    throw new UpstreamError(502, '模型上游未返回响应体')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const buffer = { text: '' }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      for (const frame of parseSseFrames(decoder.decode(value, { stream: true }), buffer)) {
        onFrame(frame.data)
      }
    }
  } finally {
    if (!signal.aborted) {
      reader.cancel().catch(() => {})
    }
  }
}

/** Anthropic Messages 协议：请求原样，SSE 事件解析后直接透传 */
const streamAnthropic = async (
  body: UpstreamRequest,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> => {
  await postSse(
    config.modelEndpoint,
    { 'x-api-key': config.modelApiKey, Authorization: `Bearer ${config.modelApiKey}` },
    { ...body, stream: true },
    signal,
    (data) => {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      if (!payload || typeof payload !== 'object') {
        return
      }
      const event = payload as StreamEvent
      if (event.type === 'error') {
        const message = (event.error as { message?: string } | undefined)?.message ?? data
        throw new UpstreamError(502, `模型流式错误：${message}`)
      }
      onEvent(event)
    }
  )
}

/** 统一入口：按 .env 的 MODEL_PROTOCOL 分发到对应适配器 */
export const streamUpstream = async (
  body: UpstreamRequest,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> => {
  switch (config.modelProtocol) {
    case 'openai-chat':
      return streamOpenAIChat(body, signal, onEvent)
    case 'openai-responses':
      return streamOpenAIResponses(body, signal, onEvent)
    default:
      return streamAnthropic(body, signal, onEvent)
  }
}
