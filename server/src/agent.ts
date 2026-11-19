import type { Request, Response } from 'express'
import { appendChatLog } from './chatlog.js'
import { config } from './config.js'
import { fileBlockToInline } from './files.js'
import { buildSkillCatalog, loadKnowledge } from './skills.js'
import { describeToolCall, executeTool, TOOL_DEFS } from './tools.js'
import { streamUpstream, UpstreamError } from './upstream.js'

/**
 * POST /v1/messages 的 Agent 循环：
 * 替换 system（人设+技能清单）→ GLM 流式生成 → tool_use 在服务端执行 → tool_result 回传续答。
 * 跨轮 SSE 事件做索引连续化重写（抑制中间轮的 message_start/message_delta/message_stop），
 * 对前端保持「一条消息、一次 message_stop」的语义。
 */

const MAX_ROUNDS = 8
/** 单轮生成上限（thinking + 正文），防止思考陷入重复时无限输出 */
const MAX_TOKENS = 8192
/** 工具执行期间向客户端发送 SSE 注释保活，避免代理层空闲断连 */
const KEEPALIVE_MS = 15_000

type ContentBlock = Record<string, unknown> & { type: string }
type ChatMessage = { role: 'user' | 'assistant'; content: unknown }

const buildSystemPrompt = (): string => {
  const parts = [config.personaBody, buildSkillCatalog(), loadKnowledge()]
    .filter((part) => part && part.trim())
  return parts.join('\n\n')
}

/** 发上游前把消息里的 file 块（本地 Files API 的 file_id）转成 base64/文本形态 */
const transformForUpstream = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message
    }
    return {
      ...message,
      content: (message.content as ContentBlock[]).map((block) => fileBlockToInline(block)),
    }
  })

/** 提取消息纯文本：content 为字符串或文本块数组 */
const messageText = (message: ChatMessage | undefined): string => {
  if (!message) {
    return ''
  }
  const content = message.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === 'object' && (block as ContentBlock).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/** 把流式增量累积到对应内容块上，供工具轮结束后整块回传 */
const accumulateDelta = (
  blocks: (ContentBlock | undefined)[],
  index: number,
  delta: Record<string, unknown> | undefined
): void => {
  if (!delta) {
    return
  }
  const block = blocks[index] ?? (blocks[index] = { type: 'unknown' })
  const append = (key: string, value: unknown): void => {
    if (typeof value === 'string') {
      block[key] = String(block[key] ?? '') + value
    }
  }
  switch (delta.type) {
    case 'text_delta':
      append('text', delta.text)
      break
    case 'thinking_delta':
      append('thinking', delta.thinking)
      break
    case 'signature_delta':
      append('signature', delta.signature)
      break
    case 'input_json_delta':
      append('partial_json', delta.partial_json)
      break
    default:
      break
  }
}

const parseToolInput = (toolUse: ContentBlock): unknown => {
  const raw = toolUse.partial_json
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw)
    } catch {
      // 拼接不完整时退回空参数
    }
  }
  return toolUse.input ?? {}
}

export const handleMessages = async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as { messages?: unknown; thinking?: unknown }
  const history: ChatMessage[] = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : []
  const lastUser = [...history].reverse().find((message) => message.role === 'user')
  const question = messageText(lastUser)

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })

  let started = false
  const send = (event: string, data: unknown): void => {
    if (!started) {
      started = true
      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const toolCalls: string[] = []
  let answerText = ''
  let errorMessage: string | undefined
  let roundsUsed = 0

  try {
    let blockOffset = 0
    let finished = false
    for (let round = 0; round < MAX_ROUNDS && !finished; round += 1) {
      roundsUsed = round + 1
      const blocks: (ContentBlock | undefined)[] = []
      let pendingDelta: Record<string, unknown> | null = null
      // 最后一轮不再提供工具：模型只能基于已获取的信息直接作答，避免打满轮次后空收尾
      const allowTools = round < MAX_ROUNDS - 1
      const system = allowTools
        ? buildSystemPrompt()
        : `${buildSystemPrompt()}\n\n注意：工具调用轮次已达上限，本轮不能再调用工具。请立即基于已获取的信息直接回答用户的问题；依据不足的部分如实说明还缺什么，不要编造。`

      await streamUpstream(
        {
          model: config.glmModel,
          system,
          messages: transformForUpstream(history),
          // 单轮输出上限：防止 thinking 陷入超长重复时无限生成
          max_tokens: MAX_TOKENS,
          thinking: (body.thinking as Record<string, unknown>) ?? { type: 'enabled' },
          ...(allowTools ? { tools: TOOL_DEFS } : {}),
        },
        controller.signal,
        (evt) => {
          switch (evt.type) {
            case 'message_start':
              // 只发首轮的 message_start，后续轮抑制
              if (round === 0) {
                send(evt.type, evt)
              }
              return
            case 'message_delta':
              // 收尾事件缓冲，仅在最终轮结束后补发
              pendingDelta = evt
              return
            case 'message_stop':
              return
            case 'ping':
              send(evt.type, evt)
              return
            case 'content_block_start':
            case 'content_block_delta':
            case 'content_block_stop': {
              const index = evt.index
              if (typeof index !== 'number') {
                return
              }
              send(evt.type, { ...evt, index: index + blockOffset })
              if (evt.type === 'content_block_start') {
                blocks[index] = { ...(evt.content_block as object) } as ContentBlock
              } else if (evt.type === 'content_block_delta') {
                accumulateDelta(blocks, index, evt.delta as Record<string, unknown>)
              }
              return
            }
            default:
              // 其余事件透传；未知类型前端解析层会静默丢弃
              send(evt.type, evt)
          }
        }
      )

      const dense = blocks.filter(Boolean) as ContentBlock[]
      blockOffset += blocks.length
      const stopReason = (pendingDelta as { delta?: { stop_reason?: string } } | null)?.delta?.stop_reason
      const toolUses = dense.filter((block) => block.type === 'tool_use')

      if (stopReason === 'tool_use' && toolUses.length > 0 && allowTools) {
        // 工具执行可能很慢（现场中继），先起保活再逐个执行
        const keepalive = setInterval(() => {
          if (!res.writableEnded) {
            res.write(': keep-alive\n\n')
          }
        }, KEEPALIVE_MS)
        const toolResults: ContentBlock[] = []
        try {
          for (const toolUse of toolUses) {
            const name = String(toolUse.name ?? '')
            const input = parseToolInput(toolUse)
            toolCalls.push(describeToolCall(name, input))
            try {
              const content = await executeTool(name, input)
              toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content })
            } catch (error) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: error instanceof Error ? error.message : String(error),
                is_error: true,
              })
            }
          }
        } finally {
          clearInterval(keepalive)
        }
        // 中间轮不回传 thinking：多轮累计会撑爆上下文并引发输出退化，工具循环只需保留正文与 tool_use
        history.push({
          role: 'assistant',
          content: dense.filter((block) => block.type !== 'thinking'),
        })
        history.push({ role: 'user', content: toolResults })
        continue
      }

      // 最终轮：补发缓冲的收尾事件
      if (pendingDelta) {
        send('message_delta', pendingDelta)
      }
      send('message_stop', { type: 'message_stop' })
      answerText = dense
        .filter((block) => block.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('')
      finished = true
    }

    if (!finished) {
      // 轮次耗尽也要按协议收尾，保证前端正常结束流
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
      })
      send('message_stop', { type: 'message_stop' })
      answerText = '（工具调用轮次达到上限，已停止生成。请缩小问题范围后重试。）'
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      errorMessage = error instanceof Error ? error.message : String(error)
      if (started) {
        send('error', { type: 'error', error: { type: 'api_error', message: errorMessage } })
      } else {
        res
          .status(error instanceof UpstreamError ? error.status : 500)
          .json({ error: { type: 'api_error', message: errorMessage } })
      }
    }
  } finally {
    res.end()
    if (!controller.signal.aborted) {
      appendChatLog(question, toolCalls, answerText, {
        model: config.glmModel,
        rounds: roundsUsed,
        error: errorMessage,
      })
    }
  }
}
