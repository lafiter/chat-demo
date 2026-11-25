import { config } from '../config.js'
import { postSse, UpstreamError, type StreamEvent, type UpstreamRequest } from '../upstream.js'

/**
 * OpenAI Responses 协议适配器（/v1/responses，Chat Completions 的后继接口）。
 * 注意：当前没有实测环境（智谱等常见厂商未开放该协议），实现依据 OpenAI 公开规范，
 * 接入真实服务后需按实际事件流核对。
 *
 * 请求：Anthropic 形态 → Responses input 数组（system→instructions、tool_use→function_call、
 *       tool_result→function_call_output、图片→input_image）
 * 响应：response.* 事件流 → Anthropic 事件
 */

type Block = Record<string, unknown> & { type: string }
type ChatMessage = { role: 'user' | 'assistant'; content: unknown }

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

type InputItem = Record<string, unknown> & { type: string }

const toResponsesInput = (messages: ChatMessage[]): InputItem[] => {
  const out: InputItem[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({
        type: message.role === 'assistant' ? 'message' : 'message',
        role: message.role,
        content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }],
      })
      continue
    }
    if (!Array.isArray(message.content)) {
      continue
    }
    for (const raw of message.content) {
      const block = raw as Block
      if (block.type === 'text' && String(block.text ?? '').trim()) {
        out.push({
          type: 'message',
          role: message.role,
          content: [
            { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(block.text ?? '') },
          ],
        })
      } else if (block.type === 'image') {
        const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
        if (source?.type === 'base64' && source.data) {
          out.push({
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_image', image_url: `data:${source.media_type ?? 'image/png'};base64,${source.data}` },
            ],
          })
        }
      } else if (block.type === 'tool_use') {
        out.push({
          type: 'function_call',
          call_id: String(block.id ?? ''),
          name: String(block.name ?? ''),
          arguments: toolArguments(block),
        })
      } else if (block.type === 'tool_result') {
        out.push({
          type: 'function_call_output',
          call_id: String(block.tool_use_id ?? ''),
          output: blockText(block.content),
        })
      }
    }
  }
  return out
}

const buildResponsesRequest = (body: UpstreamRequest): Record<string, unknown> => ({
  model: config.modelId,
  instructions: body.system,
  input: toResponsesInput(body.messages),
  ...(Array.isArray(body.tools) && body.tools.length > 0
    ? {
        tools: (body.tools as { name: string; description: string; input_schema: unknown }[]).map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        })),
      }
    : {}),
  max_output_tokens: body.max_tokens,
  stream: true,
})

/**
 * response.* 事件 → Anthropic 事件。output_item.added/done 管理块生命周期，
 * output_text/reasoning_text/function_call_arguments 的 delta 映射为对应内容块增量。
 */
export const streamOpenAIResponses = async (
  body: UpstreamRequest,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> => {
  let started = false
  let nextIndex = 0
  /** item_id → Anthropic 块 index 与类型 */
  const items = new Map<string, { index: number; kind: 'thinking' | 'text' | 'tool_use' }>()
  let finished = false

  const emit = (type: string, payload: Record<string, unknown>): void => {
    onEvent({ type, ...payload } as StreamEvent)
  }
  const closeItem = (itemId: string | undefined): void => {
    if (!itemId) {
      return
    }
    const item = items.get(itemId)
    if (item) {
      items.delete(itemId)
      emit('content_block_stop', { index: item.index })
    }
  }

  await postSse(
    config.modelEndpoint,
    { Authorization: `Bearer ${config.modelApiKey}` },
    buildResponsesRequest(body),
    signal,
    (data) => {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        return
      }
      const evt = payload as {
        type?: string
        response?: { id?: string; model?: string; error?: { message?: string }; output?: { type: string }[] }
        item?: { id?: string; type?: string; call_id?: string; name?: string }
        item_id?: string
        delta?: string
        output_index?: number
      }
      if (evt.type === 'error' || evt.response?.error) {
        const message = (evt.response?.error as { message?: string } | undefined)?.message ?? data.slice(0, 200)
        throw new UpstreamError(502, `模型流式错误：${message}`)
      }
      if (evt.type === 'response.created' && !started) {
        started = true
        emit('message_start', {
          message: {
            id: evt.response?.id ?? `resp_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model: evt.response?.model ?? config.modelId,
            content: [],
          },
        })
        return
      }
      if (evt.type === 'response.output_item.added' && evt.item) {
        const itemId = evt.item.id ?? `item_${evt.output_index ?? nextIndex}`
        if (evt.item.type === 'reasoning') {
          items.set(itemId, { index: nextIndex++, kind: 'thinking' })
          emit('content_block_start', { index: nextIndex - 1, content_block: { type: 'thinking', thinking: '', signature: '' } })
        } else if (evt.item.type === 'message') {
          items.set(itemId, { index: nextIndex++, kind: 'text' })
          emit('content_block_start', { index: nextIndex - 1, content_block: { type: 'text', text: '' } })
        } else if (evt.item.type === 'function_call') {
          items.set(itemId, { index: nextIndex++, kind: 'tool_use' })
          emit('content_block_start', {
            index: nextIndex - 1,
            content_block: { type: 'tool_use', id: evt.item.call_id ?? itemId, name: evt.item.name ?? '', input: {} },
          })
        }
        return
      }
      const item = evt.item_id ? items.get(evt.item_id) : undefined
      if (evt.type === 'response.output_text.delta' && item) {
        emit('content_block_delta', { index: item.index, delta: { type: 'text_delta', text: evt.delta ?? '' } })
        return
      }
      // 思考增量：不同实现有 reasoning_text / reasoning_summary_text 两种事件名
      if ((evt.type === 'response.reasoning_text.delta' || evt.type === 'response.reasoning_summary_text.delta') && item) {
        emit('content_block_delta', { index: item.index, delta: { type: 'thinking_delta', thinking: evt.delta ?? '' } })
        return
      }
      if (evt.type === 'response.function_call_arguments.delta' && item) {
        emit('content_block_delta', { index: item.index, delta: { type: 'input_json_delta', partial_json: evt.delta ?? '' } })
        return
      }
      if (evt.type === 'response.output_item.done') {
        closeItem(evt.item?.id)
        return
      }
      if (evt.type === 'response.completed' || evt.type === 'response.incomplete') {
        finished = true
        for (const [, value] of items) {
          emit('content_block_stop', { index: value.index })
        }
        items.clear()
        const hasFunctionCall = (evt.response?.output ?? []).some((output) => output.type === 'function_call')
        emit('message_delta', {
          delta: {
            stop_reason: hasFunctionCall ? 'tool_use' : evt.type === 'response.incomplete' ? 'max_tokens' : 'end_turn',
            stop_sequence: null,
          },
        })
        emit('message_stop', {})
      }
    }
  )
  if (started && !finished) {
    for (const [, value] of items) {
      emit('content_block_stop', { index: value.index })
    }
    emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null } })
    emit('message_stop', {})
  }
  if (!started) {
    throw new UpstreamError(502, '模型上游未返回任何流式数据（Responses 协议）')
  }
}
