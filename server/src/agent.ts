import type { Request, Response } from 'express'
import { appendChatLog } from './chatlog.js'
import { config } from './config.js'
import { fileBlockToInline } from './files.js'
import { buildSkillCatalog, loadKnowledge } from './skills.js'
import { describeToolCall, executeTool, TOOL_DEFS } from './tools.js'
import { streamUpstream, UpstreamError, type StreamEvent } from './upstream.js'

/**
 * POST /v1/messages 的 Agent 循环：
 * 替换 system（人设+技能清单）→ GLM 流式生成 → tool_use 在服务端执行 → tool_result 回传续答。
 * 跨轮 SSE 事件做索引连续化重写（抑制中间轮的 message_start/message_delta/message_stop），
 * 对前端保持「一条消息、一次 message_stop」的语义。
 */

const MAX_ROUNDS = 12
/** 工具执行期间向客户端发送 SSE 注释保活，避免代理层空闲断连 */
const KEEPALIVE_MS = 15_000
/** 部分模型在禁用工具的收尾轮会把"工具调用欲望"渲泄为正文里的伪调用标记，检测到此序列后丢弃该块后续文本 */
const DSML_MARKER = '<｜｜'
/**
 * 说明文字闸门的暂扣时长：模型常在调工具前先说一句"我先查一下"（且常是英文）。
 * 每轮的文本先扣住这么久——期间出现工具调用就整轮丢弃文本；没出现就放行并转为实时转发。
 * 取 2 秒是因为这类说明只有一句，说完立刻就是工具调用；再长会让最终回答出字明显变慢。
 */
const TEXT_HOLD_MS = 2_000
/**
 * 工具调用开始时先发给用户的一行说明。说明文字闸门生效后，调工具的那一轮不再有任何文字流出，
 * 而测算要等几十秒，页面上会出现一段"什么都没有"的空窗，用户容易以为卡住了。
 * 措辞保证在回答出来之后仍然成立（说明依据与来源），不会变成过时的"正在查询"。
 */
const TOOL_STATUS_TEXT =
  '以下内容依据库内审批通过的申报记录，按与摸底测算相同的算法得出（查询并测算约需 1 分钟）。\n\n'

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

/** 截掉伪调用标记及其后的内容：用户实际只看到标记前的部分，回传给模型的历史也应如此 */
const stripDsml = (text: string): string => {
  const at = text.indexOf(DSML_MARKER)
  return at >= 0 ? text.slice(0, at) : text
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
    // 响应已结束（异常、客户端断开）后不再写：闸门定时器等异步回调可能晚到
    if (res.writableEnded) {
      return
    }
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
  // 用户当前这句提问的原话：算分工具用它核对"用户是否真的说了截止日期"。
  // 只取当前这句——前面的 user 消息里混有前端注入的系统提醒（含当天日期），不能当作用户说过的话
  const userSaid = question

  try {
    let blockOffset = 0
    let finished = false
    /** 伪调用纠偏重试只做一次，避免模型反复退化时打满轮次 */
    let dsmlRetried = false
    /** 工具调用前的那行说明每条消息只发一次 */
    let statusSent = false
    for (let round = 0; round < MAX_ROUNDS && !finished; round += 1) {
      roundsUsed = round + 1
      const blocks: (ContentBlock | undefined)[] = []
      /** 已被 DSML 标记污染的文本块索引（本轮内），其后续 text 增量不再转发 */
      const poisonedBlocks = new Set<number>()
      /** 各 text 块为跨分片标记检测而暂扣的尾部字符 */
      const textTails = new Map<number, string>()
      let pendingDelta: Record<string, unknown> | null = null
      /**
       * 说明文字闸门：模型常在调工具前先说一句"我先查一下"（且常是英文），这句话在工具调用开始前
       * 就已流出，事后撤不回。所以本轮文本先暂扣：期间出现工具调用则整轮文本丢弃（对用户没有价值，
       * 只会泄露过程）；本轮没有工具调用则放行并转为实时转发。靠人设规则约束这件事并不可靠。
       */
      const gate: {
        mode: 'holding' | 'pass' | 'drop'
        held: StreamEvent[]
        timer: NodeJS.Timeout | undefined
        textBlocks: Set<number>
      } = {
        // 收尾轮不提供工具，不可能出现工具调用，文本直接实时转发
        mode: round < MAX_ROUNDS - 1 ? 'holding' : 'pass',
        held: [],
        timer: undefined,
        textBlocks: new Set(),
      }
      const emittedIndex = new Map<number, number>()
      let emittedCount = 0
      /** 发给前端的块序号保持连续：被闸门丢弃的文本块不占号 */
      const outIndex = (index: number): number => {
        const existing = emittedIndex.get(index)
        if (existing !== undefined) {
          return existing
        }
        const next = blockOffset + emittedCount
        emittedIndex.set(index, next)
        emittedCount += 1
        return next
      }
      /**
       * 文本事件的实际发送，带跨分片的伪调用标记过滤：标记可能被拆成 "<" + "｜｜…" 两个分片，
       * 单片匹配会漏检，因此每个 text 块保留末尾"可能是标记前缀"的 1-2 个字符，与下一分片拼接后再判断；
       * 一旦命中即视为该块被污染，截断到标记前，后续增量全部丢弃
       */
      const forwardTextEvent = (evt: StreamEvent, index: number): void => {
        const delta = evt.delta as { type?: string; text?: string } | undefined
        if (evt.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (poisonedBlocks.has(index)) {
            return
          }
          const pending = (textTails.get(index) ?? '') + delta.text
          const marker = pending.indexOf(DSML_MARKER)
          if (marker >= 0) {
            poisonedBlocks.add(index)
            textTails.delete(index)
            const clean = pending.slice(0, marker)
            if (clean) {
              send(evt.type, { ...evt, index: outIndex(index), delta: { ...delta, text: clean } })
            }
            return
          }
          let hold = 0
          for (let len = Math.min(DSML_MARKER.length - 1, pending.length); len > 0; len -= 1) {
            if (pending.endsWith(DSML_MARKER.slice(0, len))) {
              hold = len
              break
            }
          }
          const flushable = pending.slice(0, pending.length - hold)
          if (hold > 0) {
            textTails.set(index, pending.slice(pending.length - hold))
          } else {
            textTails.delete(index)
          }
          if (flushable) {
            send(evt.type, { ...evt, index: outIndex(index), delta: { ...delta, text: flushable } })
          }
          return
        }
        if (evt.type === 'content_block_stop' && !poisonedBlocks.has(index)) {
          // 块结束时把为跨分片检测扣留的尾部字符补发出去
          const tail = textTails.get(index)
          if (tail) {
            textTails.delete(index)
            send('content_block_delta', { ...evt, index: outIndex(index), delta: { type: 'text_delta', text: tail } })
          }
        }
        send(evt.type, { ...evt, index: outIndex(index) })
      }
      /** 放行：把暂扣的文本按原顺序发出，之后的文本实时转发 */
      const releaseGate = (): void => {
        if (gate.mode !== 'holding') {
          return
        }
        gate.mode = 'pass'
        if (gate.timer) {
          clearTimeout(gate.timer)
          gate.timer = undefined
        }
        const held = gate.held
        gate.held = []
        for (const evt of held) {
          forwardTextEvent(evt, evt.index as number)
        }
      }
      /** 本轮出现了工具调用：暂扣的文本全部丢弃，本轮后续文本也不再转发 */
      const dropGate = (): void => {
        gate.mode = 'drop'
        if (gate.timer) {
          clearTimeout(gate.timer)
          gate.timer = undefined
        }
        gate.held = []
      }
      const holdTextEvent = (evt: StreamEvent): void => {
        gate.held.push(evt)
        if (!gate.timer) {
          gate.timer = setTimeout(releaseGate, TEXT_HOLD_MS)
        }
      }
      // 最后一轮不再提供工具：模型只能基于已获取的信息直接作答，避免打满轮次后空收尾
      const allowTools = round < MAX_ROUNDS - 1
      const system = buildSystemPrompt()
      // 收尾轮不给工具，并以消息级指令要求立即交卷——只改 system 时部分模型会把
      // "调不了工具"渲泄为正文伪调用标记（DSML），末位 user 指令的收敛效果好得多
      const upstreamMessages = allowTools
        ? transformForUpstream(history)
        : [
            ...transformForUpstream(history),
            {
              role: 'user' as const,
              content:
                '（系统提示：工具轮次已用尽。请立即基于以上已获取的全部记录输出最终答案——构成明细表+办法依据+待核项，'
                + '正文必须是给用户看的完整回答，禁止出现任何工具调用或伪调用标记。）',
            },
          ]

      try {
      await streamUpstream(
        {
          model: config.modelId,
          system,
          messages: upstreamMessages,
          // 单轮输出上限：防止 thinking 陷入超长重复时无限生成
          max_tokens: config.modelMaxTokens,
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
              const startedType =
                evt.type === 'content_block_start'
                  ? String((evt.content_block as { type?: unknown } | undefined)?.type ?? '')
                  : ''
              // 内部累积始终记原文：回传给模型的历史、伪调用检测都要看到模型真正输出了什么
              // （之前被过滤掉的文本也没进历史，导致纠偏重试的检测条件永远不成立）
              if (evt.type === 'content_block_start') {
                blocks[index] = { ...(evt.content_block as object) } as ContentBlock
              } else if (evt.type === 'content_block_delta') {
                accumulateDelta(blocks, index, evt.delta as Record<string, unknown>)
              }
              if (startedType === 'text') {
                gate.textBlocks.add(index)
              }
              if (startedType === 'tool_use') {
                // 整条消息里还没露出任何文字时，在第一个工具调用块之前先发一行说明（每条消息只发一次）
                if (gate.mode === 'holding' && !statusSent) {
                  statusSent = true
                  const statusIndex = blockOffset + emittedCount
                  emittedCount += 1
                  send('content_block_start', {
                    type: 'content_block_start',
                    index: statusIndex,
                    content_block: { type: 'text', text: '' },
                  })
                  send('content_block_delta', {
                    type: 'content_block_delta',
                    index: statusIndex,
                    delta: { type: 'text_delta', text: TOOL_STATUS_TEXT },
                  })
                  send('content_block_stop', { type: 'content_block_stop', index: statusIndex })
                }
                dropGate()
              }
              if (startedType === 'text' || gate.textBlocks.has(index)) {
                if (gate.mode === 'drop') {
                  return
                }
                if (gate.mode === 'holding') {
                  holdTextEvent(evt)
                  return
                }
                forwardTextEvent(evt, index)
                return
              }
              // 思考块、工具调用块不受闸门影响
              send(evt.type, { ...evt, index: outIndex(index) })
              return
            }
            default:
              // 其余事件透传；未知类型前端解析层会静默丢弃
              send(evt.type, evt)
          }
        }
      )
      } finally {
        // 异常或中断退出时清掉闸门定时器，避免它晚些时候往已结束的响应里写数据
        if (gate.timer) {
          clearTimeout(gate.timer)
          gate.timer = undefined
        }
      }
      // 流结束仍在暂扣的文本（本轮没有工具调用，就是给用户的回答）按原顺序放出
      releaseGate()

      const dense = blocks.filter(Boolean) as ContentBlock[]
      blockOffset += emittedCount
      const stopReason = (pendingDelta as { delta?: { stop_reason?: string } } | null)?.delta?.stop_reason
      const toolUses = dense.filter((block) => block.type === 'tool_use')

      // 伪调用纠偏：本轮提供了工具却没有真实 tool_use，反而把调用写成了正文标记——
      // 这轮结论没有价值（用户只会看到"我来查…"的空话），丢弃并重来一轮
      const roundText = dense
        .filter((block) => block.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('')
      if (allowTools && toolUses.length === 0 && roundText.includes(DSML_MARKER) && !dsmlRetried) {
        dsmlRetried = true
        const cleanText = stripDsml(roundText).trim()
        if (cleanText) {
          history.push({ role: 'assistant', content: [{ type: 'text', text: cleanText }] })
        }
        history.push({
          role: 'user',
          content:
            '（系统提示：你上一条没有发起真实的工具调用，而是把要调用的工具写成了正文文本，这是错误的。' +
            '请立即通过工具调用机制重新发起真实调用，正文中不得出现任何调用标记，也不要输出说明文字。）',
        })
        continue
      }

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
            const toolStarted = Date.now()
            // 日志里记"调了什么 + 结果如何 + 用时"：只记调用名的话，"模型为什么重调"这类问题无从排查
            const brief = describeToolCall(name, input)
            try {
              // 把用户原话一并交给工具：算分工具据此核对模型传入的截止日期有没有依据（模型无法伪造）
              const content = await executeTool(name, input, { userSaid })
              const seconds = Math.round((Date.now() - toolStarted) / 1000)
              toolCalls.push(`${brief} → 成功 ${seconds}s`)
              console.log(`[tool] ${brief} 成功 ${seconds}s`)
              toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              toolCalls.push(`${brief} → 失败：${message.slice(0, 300)}`)
              console.warn(`[tool] ${brief} 失败：${message.slice(0, 300)}`)
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: message,
                is_error: true,
              })
            }
          }
        } finally {
          clearInterval(keepalive)
        }
        // 中间轮不回传 thinking：多轮累计会撑爆上下文并引发输出退化，工具循环只需保留正文与 tool_use。
        // 正文截掉伪调用标记及其后的内容（用户实际只看到标记前的部分），空文本块不留
        history.push({
          role: 'assistant',
          content: dense
            .filter((block) => block.type !== 'thinking')
            .map((block) => (block.type === 'text' ? { ...block, text: stripDsml(String(block.text ?? '')) } : block))
            .filter((block) => block.type !== 'text' || String(block.text).trim() !== ''),
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
        .map((block) => stripDsml(String(block.text ?? '')))
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
    // 中断的请求也留痕（页面刷新、BFF 重启窗口撞车等），便于事后排查"发了却查无记录"
    appendChatLog(question, toolCalls, answerText, {
      model: config.modelId,
      rounds: roundsUsed,
      error:
        errorMessage ??
        (controller.signal.aborted ? '（客户端中断/连接断开，未完成）' : undefined),
    })
  }
}
