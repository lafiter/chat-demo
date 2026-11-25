import { config } from '../config.js'
import { postSse, UpstreamError, type StreamEvent, type UpstreamRequest } from '../upstream.js'

/**
 * OpenAI Chat Completions 协议适配器（兼容各类 OpenAI 风格网关/厂商）。
 * 请求：Anthropic 形态 → OpenAI chat 形态（system 并入消息、tool_result 拆为 role:tool、
 *       图片 base64 → image_url、tool_use → tool_calls）
 * 响应：流式 chunk → Anthropic 事件（message_start / content_block_* / message_delta / message_stop）
 */

type Block = Record<string, unknown> & { type: string }
type ChatMessage = { role: 'user' | 'assistant'; content: unknown }

type OpenAIMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: unknown[] }

const blockText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === 'object' && (item as Block).type === 'text'
          ? String((item as { text?: unknown }).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/** tool_use 参数在 Agent 内部可能存于 input（对象）或 partial_json（流式拼接串） */
const toolArguments = (block: Block): string => {
  const partial = block.partial_json
  if (typeof partial === 'string' && partial.trim()) {
    try {
      JSON.parse(partial)
      return partial
    } catch {
      // 拼接不完整时退回 input
    }
  }
  return JSON.stringify(block.input ?? {})
}

/** Anthropic 消息数组 → OpenAI 消息数组；user 里的 tool_result 拆成独立的 role:tool 消息 */
const toOpenAIMessages = (system: string, messages: ChatMessage[]): OpenAIMessage[] => {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content })
      continue
    }
    if (!Array.isArray(message.content)) {
      continue
    }
    if (message.role === 'assistant') {
      let text = ''
      const toolCalls: unknown[] = []
      for (const raw of message.content) {
        const block = raw as Block
        if (block.type === 'text') {
          text += String(block.text ?? '')
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: { name: String(block.name ?? ''), arguments: toolArguments(block) },
          })
        }
        // thinking 块 OpenAI 协议不回传
      }
      out.push(
        toolCalls.length > 0
          ? { role: 'assistant', content: text || null, tool_calls: toolCalls }
          : { role: 'assistant', content: text }
      )
      continue
    }
    // user：tool_result 先行拆出，text 与 image 汇成一条 user 消息
    const parts: unknown[] = []
    for (const raw of message.content) {
      const block = raw as Block
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id ?? ''),
          content: blockText(block.content),
        })
      } else if (block.type === 'text' && String(block.text ?? '').trim()) {
        parts.push({ type: 'text', text: String(block.text ?? '') })
      } else if (block.type === 'image') {
        const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
        if (source?.type === 'base64' && source.data) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${source.media_type ?? 'image/png'};base64,${source.data}` },
          })
        }
      }
    }
    if (parts.length > 0) {
      const single = parts.length === 1 ? (parts[0] as { type?: string; text?: string }) : null
      out.push({ role: 'user', content: single?.type === 'text' && single.text !== undefined ? single.text : parts })
    }
  }
  return out
}

const buildChatRequest = (body: UpstreamRequest): Record<string, unknown> => ({
  model: config.modelId,
  messages: toOpenAIMessages(body.system, body.messages),
  ...(Array.isArray(body.tools) && body.tools.length > 0
    ? {
        tools: (body.tools as { name: string; description: string; input_schema: unknown }[]).map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
        })),
      }
    : {}),
  max_tokens: body.max_tokens,
  // 网关实测认 Anthropic 形态的 thinking 参数：{"type":"disabled"} 可关闭长思考，透传前端开关
  ...(body.thinking ? { thinking: body.thinking } : {}),
  stream: true,
  stream_options: { include_usage: true },
})

const STOP_REASON_MAP: Record<string, string> = {
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  stop: 'end_turn',
  length: 'max_tokens',
  content_filter: 'refusal',
}

/**
 * 流式 chunk → Anthropic 事件。状态机管理三类块：
 * thinking（delta.reasoning_content）、text（delta.content）、tool_use（delta.tool_calls）。
 */
export const streamOpenAIChat = async (
  body: UpstreamRequest,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> => {
  let started = false
  let nextIndex = 0
  let openBlock: 'thinking' | 'text' | null = null
  const toolIndexes = new Map<number, number>()
  let finished = false

  const emit = (type: string, payload: Record<string, unknown>): void => {
    onEvent({ type, ...payload } as StreamEvent)
  }
  const closeOpenBlock = (): void => {
    if (openBlock !== null) {
      emit('content_block_stop', { index: nextIndex - 1 })
      openBlock = null
    }
  }

  await postSse(
    config.modelEndpoint,
    { Authorization: `Bearer ${config.modelApiKey}` },
    buildChatRequest(body),
    signal,
    (data) => {
      if (data === '[DONE]') {
        return
      }
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      const chunk = payload as {
        id?: string
        model?: string
        error?: { message?: string }
        choices?: {
          delta?: {
            content?: string | null
            reasoning_content?: string | null
            reasoning?: string | null
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          }
          finish_reason?: string | null
        }[]
      }
      if (chunk.error) {
        throw new UpstreamError(502, `模型流式错误：${chunk.error.message ?? data.slice(0, 200)}`)
      }
      const choice = chunk.choices?.[0]
      if (!started) {
        started = true
        emit('message_start', {
          message: { id: chunk.id ?? `chat_${Date.now()}`, type: 'message', role: 'assistant', model: chunk.model ?? config.modelId, content: [] },
        })
      }
      const delta = choice?.delta
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        if (openBlock !== 'thinking') {
          closeOpenBlock()
          emit('content_block_start', { index: nextIndex, content_block: { type: 'thinking', thinking: '', signature: '' } })
          openBlock = 'thinking'
          nextIndex += 1
        }
        emit('content_block_delta', { index: nextIndex - 1, delta: { type: 'thinking_delta', thinking: reasoning } })
      }
      if (typeof delta?.content === 'string' && delta.content) {
        if (openBlock !== 'text') {
          closeOpenBlock()
          emit('content_block_start', { index: nextIndex, content_block: { type: 'text', text: '' } })
          openBlock = 'text'
          nextIndex += 1
        }
        emit('content_block_delta', { index: nextIndex - 1, delta: { type: 'text_delta', text: delta.content } })
      }
      for (const call of delta?.tool_calls ?? []) {
        closeOpenBlock()
        const key = call.index ?? 0
        if (!toolIndexes.has(key)) {
          emit('content_block_start', {
            index: nextIndex,
            content_block: { type: 'tool_use', id: call.id ?? `call_${key}_${Date.now()}`, name: call.function?.name ?? '', input: {} },
          })
          toolIndexes.set(key, nextIndex)
          nextIndex += 1
        }
        if (call.function?.arguments) {
          emit('content_block_delta', {
            index: toolIndexes.get(key) as number,
            delta: { type: 'input_json_delta', partial_json: call.function.arguments },
          })
        }
      }
      const finish = choice?.finish_reason
      if (finish && !finished) {
        finished = true
        closeOpenBlock()
        for (const index of toolIndexes.values()) {
          emit('content_block_stop', { index })
        }
        emit('message_delta', {
          delta: { stop_reason: STOP_REASON_MAP[finish] ?? 'end_turn', stop_sequence: null },
        })
        emit('message_stop', {})
      }
    }
  )
  // 流结束仍未见 finish_reason 时按协议补齐收尾
  if (started && !finished) {
    closeOpenBlock()
    for (const index of toolIndexes.values()) {
      emit('content_block_stop', { index })
    }
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null } })
    emit('message_stop', {})
  }
  if (!started) {
    throw new UpstreamError(502, '模型上游未返回任何流式数据')
  }
}
