import { config } from './config.js'
import { runSiteTool } from './mcp.js'
import { readSkillFile } from './skills.js'

/** 暴露给模型的工具（Anthropic 格式）：技能读取 + 现场数据只读查询 */

export type ToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'read_skill_file',
    description:
      '读取职称评聘技能包内的参考文件（SKILL.md 流程与口径、规则映射、排查 SQL 模板、办法全文对照等）。path 为相对技能根目录的路径，如 "zcps-score-audit/references/query-patterns.md"。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对技能根目录的文件路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'query_zcps_sql',
    description:
      '在山东医药技师学院「表单工作站」数据源上执行只读 SQL（含 V_RSC_* 计分视图与 DA022_* 业绩申报表）。约束：Oracle 11g 语法（分页用 ROWNUM<=n，不支持 FETCH FIRST）；不要加 schema 前缀；只支持单条 SELECT/WITH 语句；最多返回 limit 行（1-100，默认 100），大结果必须用 WHERE 收窄。返回 JSON：{ rowCount, rows }。' +
      '高频表真实列名（禁止猜列名，不确定就先 get_table_schema 或读技能包 query-patterns.md）：' +
      'V_RSC_GWJP_JSXX→zgh/xm/rdsj/rdsj_up；DA022_T_JSJBXX→c_zgh/c_xm/c_ssbm；da129_zcps→c_zgh/xm/series_id/jslb；' +
      'DA022_T_JSJBXX_G_5O1I→c_zgh/c_ovuz/c_m7xd。',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '只读 SELECT 或 WITH 查询语句' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回行数上限，默认 100' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'get_table_schema',
    description: '查「表单工作站」数据源中表或视图的结构（列名与类型），用于确认字段后再写查询。',
    input_schema: {
      type: 'object',
      properties: {
        tableName: { type: 'string', description: '表或视图名，不带 schema 前缀' },
      },
      required: ['tableName'],
    },
  },
]

/** 只读校验：单条 SELECT/WITH；去尾分号后不允许再出现分号（防多语句） */
const assertReadOnlySql = (sql: string): string => {
  const trimmed = sql.trim().replace(/;+\s*$/, '').trim()
  if (!trimmed) {
    throw new Error('SQL 不能为空')
  }
  if (trimmed.includes(';')) {
    throw new Error('不允许一次执行多条语句')
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error('只允许 SELECT / WITH 开头的只读查询')
  }
  return trimmed
}

const clampLimit = (value: unknown): number => {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) {
    return 100
  }
  return Math.min(100, Math.max(1, Math.floor(num)))
}

const asRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}

/** 执行工具并返回给模型的文本结果；失败抛错，由调用方转 is_error 的 tool_result */
export const executeTool = async (name: string, input: unknown): Promise<string> => {
  const args = asRecord(input)
  if (name === 'read_skill_file') {
    const relPath = String(args.path ?? '')
    if (!relPath) {
      throw new Error('缺少 path 参数')
    }
    return readSkillFile(relPath)
  }
  if (name === 'query_zcps_sql') {
    const sql = assertReadOnlySql(String(args.sql ?? ''))
    const limit = clampLimit(args.limit)
    try {
      const result = (await runSiteTool('preview_table_data', {
        dataSourceId: config.dataSourceId,
        customSql: sql,
        limit,
      })) as { data?: { rowCount?: number; rows?: unknown[] } }
      const data = result?.data ?? {}
      return JSON.stringify({ rowCount: data.rowCount ?? data.rows?.length ?? 0, rows: data.rows ?? [] })
    } catch (error) {
      // 现场平台把 SQL 语法/列名错误统一包装成笼统的「执行失败」，把可行动的排查指引附给模型，
      // 避免它误读为"参数未传递"而反复盲试
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${message}\n该报错最常见原因是列名/表名写错（现场不返回具体 ORA 错误码）。` +
          '不要换着列名盲试：先用 get_table_schema 查表结构，或直接采用技能包 query-patterns.md 模板里的真实列名' +
          '（如 V_RSC_GWJP_JSXX→zgh/xm，DA022_T_JSJBXX→c_zgh/c_xm/c_ssbm）重写后重试。'
      )
    }
  }
  if (name === 'get_table_schema') {
    const tableName = String(args.tableName ?? '').trim()
    if (!tableName) {
      throw new Error('缺少 tableName 参数')
    }
    const result = await runSiteTool('get_table_schema', {
      dataSourceId: config.dataSourceId,
      tableName,
    })
    return JSON.stringify(result)
  }
  throw new Error(`未知工具：${name}`)
}

/** 聊天日志里对一次工具调用的简述 */
export const describeToolCall = (name: string, input: unknown): string => {
  const args = asRecord(input)
  if (name === 'query_zcps_sql') {
    const sql = String(args.sql ?? '').replace(/\s+/g, ' ').slice(0, 160)
    return `query_zcps_sql(\`${sql}\`)`
  }
  const brief = Object.entries(args)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(', ')
  return `${name}(${brief})`
}
