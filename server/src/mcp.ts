import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { config } from './config.js'

/** datacenter MCP 客户端：连接与两步中继封装 */

let client: Client | null = null

const extractText = (result: unknown): string => {
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((block) => (typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .join('')
}

/** callTool 返回值统一解包：优先 structuredContent，否则解析文本块里的 JSON */
const callTool = async <T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>
): Promise<T> => {
  if (!client) {
    throw new Error('MCP 客户端未连接')
  }
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) {
    throw new Error(extractText(result) || `MCP 工具 ${name} 调用失败`)
  }
  const structured = (result as { structuredContent?: unknown }).structuredContent
  if (structured && typeof structured === 'object') {
    const wrapped = structured as { data?: unknown }
    return ('data' in wrapped && wrapped.data && typeof wrapped.data === 'object'
      ? wrapped.data
      : structured) as T
  }
  const text = extractText(result)
  if (!text) {
    throw new Error(`MCP 工具 ${name} 返回为空`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`MCP 工具 ${name} 返回无法解析：${text.slice(0, 200)}`)
  }
}

/** 建客户端并连接，返回就绪的 Client 实例 */
const connectWith = async (makeTransport: () => Transport): Promise<Client> => {
  const instance = new Client({ name: 'zcps-assistant-bff', version: '0.1.0' })
  await instance.connect(makeTransport())
  return instance
}

/** 连接 datacenter MCP：优先 Streamable HTTP，失败回退旧版 SSE 传输 */
export const connectMcp = async (): Promise<void> => {
  const url = new URL(config.mcpUrl)
  const requestInit = { headers: { Authorization: `Bearer ${config.mcpToken}` } }
  const attempts: (() => Promise<Client>)[] = [
    () => connectWith(() => new StreamableHTTPClientTransport(url, { requestInit })),
    () => connectWith(() => new SSEClientTransport(url, { requestInit })),
  ]
  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      client = await attempt()
      return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`无法连接 datacenter MCP（${config.mcpUrl}）：${String(lastError)}`)
}

type SiteOperation = {
  operationId?: string
  completed?: boolean
  success?: boolean
  result?: unknown
  state?: string
  error?: { message?: string } | string
  /**
   * 现场结果序列化后超过 12000 字符时，中继不再返回 result，而是把结果 JSON 文本切片分页返回；
   * 此时须按 nextArguments 续取，全部拼完才能解析（实测 83 人批量测算的 3 条查询因此取不到结果）
   */
  resultPage?: { content?: string; offset?: number; nextOffset?: number; hasMore?: boolean }
  nextArguments?: Record<string, unknown>
}

const opError = (op: SiteOperation): string =>
  typeof op.error === 'string' ? op.error : (op.error?.message ?? `状态 ${op.state ?? '未知'}`)

/** 续取并拼接分页结果：resultPage.content 是现场结果 JSON 文本的切片，按 offset 顺序拼完再解析 */
const stitchResult = async (first: SiteOperation): Promise<unknown> => {
  let text = ''
  let page = first.resultPage
  let next = first.nextArguments
  // 上限防御：200 页约 240 万字符，正常结果到不了；到不了却仍在续页说明中继分页异常
  for (let guard = 0; page?.content && guard < 200; guard += 1) {
    text += page.content
    const offset = next?.offset
    // 没有下一页、或偏移量不再前进，即停止
    if (!page.hasMore || typeof offset !== 'number' || offset <= (page.offset ?? -1)) {
      break
    }
    const more = await callTool<SiteOperation>('get_site_tool_operation', next as Record<string, unknown>)
    page = more.resultPage
    next = more.nextArguments
  }
  return JSON.parse(text) as unknown
}

/**
 * 经总台中继执行现场平台原生工具（两步异步）：
 * query_site_platform_tool 发起 → 未完成时用 get_site_tool_operation 轮询到出结果。
 */
export const runSiteTool = async (
  nativeTool: string,
  args: Record<string, unknown>,
  timeoutMs = config.mcpToolTimeoutMs
): Promise<unknown> => {
  let op = await callTool<SiteOperation>('query_site_platform_tool', {
    siteId: config.siteId,
    idempotencyKey: randomUUID(),
    name: nativeTool,
    arguments: args,
  })
  const deadline = Date.now() + timeoutMs
  while (!op.completed) {
    if (Date.now() > deadline) {
      throw new Error(`现场工具 ${nativeTool} 执行超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    if (!op.operationId) {
      throw new Error(`现场工具 ${nativeTool} 未返回 operationId：${opError(op)}`)
    }
    op = await callTool<SiteOperation>('get_site_tool_operation', {
      siteId: config.siteId,
      operationId: op.operationId,
      waitSeconds: 10,
    })
  }
  if (!op.success) {
    throw new Error(`现场工具 ${nativeTool} 执行失败：${opError(op)}`)
  }
  if (op.result !== undefined) {
    return op.result
  }
  return op.resultPage ? stitchResult(op) : undefined
}

/** 启动自检：一条无害查询验证链路（鉴权、网络、中继、数据源） */
export const selfCheck = async (): Promise<void> => {
  const result = (await runSiteTool(
    'preview_table_data',
    {
      dataSourceId: config.dataSourceId,
      customSql: 'SELECT 1 AS ok FROM dual WHERE ROWNUM<=1',
      limit: 1,
    },
    60_000
  )) as { data?: { rows?: unknown[] } }
  if (!result?.data?.rows?.length) {
    throw new Error('自检查询未返回数据')
  }
}
