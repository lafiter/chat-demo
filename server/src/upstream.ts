import { config } from './config.js'

/** GLM Anthropic 兼容端点的流式调用与 SSE 解析 */

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

type StreamEvent = Record<string, unknown> & { type: string }

/** 简化版 SSE 解析：按空行分帧，取 event 与 data 字段（与上游帧格式一致） */
const parseSseFrames = (chunk: string, buffer: { text: string }): { event: string; data: string }[] => {
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

/**
 * 调 GLM /anthropic/v1/messages（stream: true），逐个产出解析后的事件对象。
 * 非 2xx 或流中 error 帧抛 UpstreamError；signal 中止时向上传播 AbortError。
 */
export const streamUpstream = async (
  body: Record<string, unknown>,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> => {
  const messagesUrl = `${config.upstreamRoot}/anthropic/v1/messages`
  let response: Response
  try {
    response = await fetch(messagesUrl, {
      method: 'POST',
      headers: {
        'x-api-key': config.glmApiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    })
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    throw new UpstreamError(502, `无法连接 GLM 上游：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let message = text || response.statusText
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      if (parsed.error?.message) {
        message = parsed.error.message
      }
    } catch {
      // 非 JSON 错误体直接展示原文
    }
    throw new UpstreamError(response.status, message)
  }
  if (!response.body) {
    throw new UpstreamError(502, 'GLM 上游未返回响应体')
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
        let payload: unknown
        try {
          payload = JSON.parse(frame.data)
        } catch {
          continue
        }
        if (!payload || typeof payload !== 'object') {
          continue
        }
        const event = payload as StreamEvent
        if (event.type === 'error') {
          const message =
            (event.error as { message?: string } | undefined)?.message ?? frame.data
          throw new UpstreamError(502, `GLM 流式错误：${message}`)
        }
        onEvent(event)
      }
    }
  } finally {
    if (!signal.aborted) {
      reader.cancel().catch(() => {})
    }
  }
}
