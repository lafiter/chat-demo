import { readFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { runSiteTool } from './mcp.js'

/**
 * 原始分测算引擎（与摸底测算同源）。
 *
 * SQL 模板与本轮参数放在技能包 scoring/ 目录，由本引擎和 scripts/build_queries.py 共用：
 * 改口径只改文件，不用改代码。合并规则照 scripts/merge_final.py 翻译，不引入新算法。
 * 模型只负责收集入参和解释结果，不自己算分。
 */

export type PostSeq = 'JX' | 'XG' | 'GF'
type LevelBand = 'zgj' | 'fgj' | 'zj' | 'cj'
type Series = '01' | '02'

export type ScorePersonInput = {
  zgh: string
  /** 起聘月；接受 2023-09 / 2023-9 / 2023年9月 等写法 */
  rdsj?: string
  /** 拟聘等级；如 专技五级 / 专业技术五级岗位 / 副高7级 */
  level?: string
  /** 主系列 / 辅系列 */
  series?: string
  /** 岗位序列：教学 / 学工 / 管理和辅助 */
  postSeq?: string
  /** 可选：用户给的姓名，用于和库内姓名核对工号是否输错 */
  name?: string
}

/**
 * 用户明确给了不同截止日期时传入；不传用本轮参数。
 * userSaid 是用户当前这句提问的原话（由服务端传入，不由模型转述）：覆盖截止日期必须能在原话里找到依据。
 */
export type ScoreConfigOverrides = {
  cutoffYeji?: string
  cutoffGzl?: string
  rzCutoff?: string
  userSaid?: string
}

type RoundConfig = {
  cutoffYeji: string
  cutoffGzl: string
  cqYearMax: string
  rzCutoff: string
  formJxgzl: string
  caps: { jcf: number; gzlf: number; gzzlf: number; zygzf: number; gw: number; gwItem: number }
  rosterCsv?: string
  /** 摸底表的名称（回答里对比时要说明这是摸底表的数） */
  rosterLabel?: string
}

type SqlTemplates = {
  batches: Record<string, { title: string; mdCols: string[]; outColumns: string[]; sql: string }>
}

export type InternalPerson = {
  zgh: string
  rdsj: string
  xl: Series
  dj: LevelBand
  postSeq: PostSeq
  /** 各入参来源：user / roster / default，回答里需要声明 */
  sources: { rdsj: string; level: string; series: string; postSeq: string }
  /** 入参层面的提示（用户给的与名单不一致、无法识别已改用名单等），原样带给模型 */
  warnings: string[]
}

type RosterRow = {
  name: string
  rdsj: string
  levelText: string
  series: string
  postSeq: string
  /** 摸底表里此人的各列分数（"原始分总分"及其后的列），用于"与摸底表是否一致"的对比 */
  scores?: Record<string, number>
}

/** 中继单次查询最多返回 100 行，名单一次最多算这些人 */
export const MAX_PEOPLE_PER_CALC = 100

const scoringDir = path.join(config.skillsRoot, 'zcps-score-audit', 'scoring')
const BATCH_KEYS = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'] as const

const LEVEL_LABEL: Record<LevelBand, string> = { zgj: '正高', fgj: '副高', zj: '中级', cj: '初级' }
const POST_SEQ_LABEL: Record<PostSeq, string> = { JX: '教学序列', XG: '学工序列', GF: '管理和辅助序列' }
const CN_DIGIT: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, '十一': 11, '十二': 12,
}

const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(path.join(scoringDir, file), 'utf8').replace(/^\uFEFF/, '')) as T

/** 两位小数四舍五入（与 merge_final.py 的 Decimal ROUND_HALF_UP 一致：按最短十进制表示取半进位） */
const r2 = (x: number): number => Number(`${Math.round(Number(`${x}e2`))}e-2`)
/** 输出给模型的分数一律是两位小数的文本：与摸底表版式一致，模型照抄即可，不会出现 3.9 / 5 / 16.88 混排 */
const fx = (x: number): string => r2(x).toFixed(2)
const num = (value: unknown): number => {
  if (value === null || value === undefined || value === '') {
    return 0
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`查询结果里有无法识别的数值：${String(value)}`)
  }
  return parsed
}
const months = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7))

export class ScoreInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScoreInputError'
  }
}

/** "2023-09" / "2023-9" / "2023年9月" / "2023/09" → "2023-09"。月份必须补零：SQL 里按字符串比较年月，"2019-7" 会被判到 12 月之后 */
export const normalizeMonth = (value: unknown): string => {
  const match = /^(\d{4})\D*(\d{1,2})\D*$/.exec(String(value ?? '').trim())
  if (!match) {
    throw new ScoreInputError(`年月格式无法识别：${String(value)}（应为 2023-09 这样的年月）`)
  }
  const month = Number(match[2])
  if (month < 1 || month > 12) {
    throw new ScoreInputError(`月份超出范围：${String(value)}`)
  }
  return `${match[1]}-${String(month).padStart(2, '0')}`
}

/** 拟聘等级文本 → 档位：1-4 级正高、5-7 级副高、8-10 级中级、11-12 级初级（与 build_queries.py 的 DJ 一致） */
export const parseLevelBand = (value: unknown): LevelBand => {
  const text = String(value ?? '').trim()
  if (/正高|正级/.test(text)) {
    return 'zgj'
  }
  if (/副高/.test(text)) {
    return 'fgj'
  }
  const level = /((?:十一|十二)|十|[一二三四五六七八九]|1[012]|[1-9])\s*级/.exec(text)
  const number = level ? CN_DIGIT[level[1]] ?? Number(level[1]) : NaN
  if (number >= 1 && number <= 4) {
    return 'zgj'
  }
  if (number >= 5 && number <= 7) {
    return 'fgj'
  }
  if (number >= 8 && number <= 10) {
    return 'zj'
  }
  if (number >= 11 && number <= 12) {
    return 'cj'
  }
  throw new ScoreInputError(`拟聘等级无法识别：${text || '（未提供）'}（如 专技五级 / 专业技术五级岗位 / 副高7级）`)
}

const parseSeries = (value: unknown): Series | null => {
  const text = String(value ?? '').trim()
  if (/辅/.test(text) || text === '02') {
    return '02'
  }
  if (/主/.test(text) || text === '01') {
    return '01'
  }
  return null
}

const parsePostSeq = (value: unknown): PostSeq | null => {
  const text = String(value ?? '').trim()
  if (/教学/.test(text)) {
    return 'JX'
  }
  if (/学工/.test(text)) {
    return 'XG'
  }
  if (/管理|管辅/.test(text)) {
    return 'GF'
  }
  return null
}

/** 极简 CSV 解析（支持双引号包裹与转义），用于读摸底名单；回归脚本也用它读基准表 */
export const parseCsvText = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const source = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') {
        i += 1
      }
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((c) => c.trim() !== ''))
}

/** 摸底名单（当轮名单的留档）：用户没给的入参从这里取，取不到再向用户要 */
const loadRoster = (cfg: RoundConfig): Map<string, RosterRow> => {
  const roster = new Map<string, RosterRow>()
  if (!cfg.rosterCsv) {
    return roster
  }
  const file = path.resolve(scoringDir, cfg.rosterCsv)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return roster
  }
  const [header, ...rows] = parseCsvText(text)
  if (!header) {
    return roster
  }
  const col = (name: string): number => header.indexOf(name)
  const idx = { zgh: col('工号'), name: col('姓名'), series: col('序列'), postSeq: col('岗位序列'), level: col('拟竞聘岗位'), rdsj: col('起聘时间') }
  if (Object.values(idx).some((i) => i < 0)) {
    return roster
  }
  const scoreStart = header.indexOf('原始分总分')
  for (const cells of rows) {
    const zgh = String(cells[idx.zgh] ?? '').split('.')[0].slice(0, 6)
    if (!zgh) {
      continue
    }
    const scores: Record<string, number> = {}
    if (scoreStart >= 0) {
      header.slice(scoreStart).forEach((name, offset) => {
        const text = (cells[scoreStart + offset] ?? '').trim()
        if (text !== '' && Number.isFinite(Number(text))) {
          scores[name] = Number(text)
        }
      })
    }
    roster.set(zgh, {
      name: String(cells[idx.name] ?? '').trim(),
      series: String(cells[idx.series] ?? '').trim(),
      postSeq: String(cells[idx.postSeq] ?? '').trim(),
      levelText: String(cells[idx.level] ?? '').trim(),
      rdsj: String(cells[idx.rdsj] ?? '').trim(),
      scores,
    })
  }
  return roster
}

/** 从用户原话里找出提到过的年月："2026年11月" / "26.10.31日" / "2026-11" / "十一月" / "11月底" */
const monthsMentioned = (text: string): { year: number | null; month: number }[] => {
  const found: { year: number | null; month: number }[] = []
  for (const match of text.matchAll(/(\d{2,4})\s*[年.\-/]\s*(\d{1,2})(?!\d)/g)) {
    const year = Number(match[1])
    found.push({ year: year < 100 ? 2000 + year : year, month: Number(match[2]) })
  }
  for (const match of text.matchAll(/(十[一二]?|[一二三四五六七八九])\s*月/g)) {
    found.push({ year: null, month: CN_DIGIT[match[1]] })
  }
  for (const match of text.matchAll(/(?<![\d年.\-/])(\d{1,2})\s*月(?![份])/g)) {
    found.push({ year: null, month: Number(match[1]) })
  }
  return found.filter((item) => item.month >= 1 && item.month <= 12)
}

const loadRoundConfig = (overrides: ScoreConfigOverrides = {}): RoundConfig => {
  const cfg = readJson<RoundConfig>('round-config.json')
  // 只采纳有值的覆盖项：调用方可能带着值为 undefined 的键，不能让它们把默认参数冲掉
  const given: Partial<Record<'cutoffYeji' | 'cutoffGzl' | 'rzCutoff', string>> = {}
  for (const key of ['cutoffYeji', 'cutoffGzl', 'rzCutoff'] as const) {
    const value = overrides[key]
    if (typeof value === 'string' && value.trim()) {
      given[key] = value.trim()
    }
  }
  // 覆盖默认截止日期必须对得上用户原话：模型曾自行编一个截止日期传进来
  const overridden = Object.keys(given) as (keyof typeof given)[]
  if (overridden.length > 0) {
    const said = overrides.userSaid ?? ''
    const mentioned = monthsMentioned(said)
    const unjustified = overridden.filter((key) => {
      const value = given[key] ?? ''
      const year = Number(value.slice(0, 4))
      const month = Number(value.slice(5, 7))
      return !mentioned.some((item) => item.month === month && (item.year === null || item.year === year))
    })
    if (unjustified.length > 0) {
      throw new ScoreInputError(
        `截止日期 ${unjustified.map((key) => `${key}=${given[key]}`).join('、')} 在用户这句话里找不到（用户原话：${said || '（空）'}）。` +
          '只有用户明确说了截止日期才允许覆盖默认口径；用户没说就去掉 config 按默认口径重新调用。'
      )
    }
    // 年月对得上还不够：业绩截止、教学工作量截止、任职年限截止是三个独立口径。
    // 用户只说"业绩认定截止 X"时只能改业绩截止——模型曾顺手把教学工作量截止也改成同一个月
    const needsMention: Partial<Record<keyof typeof given, { aspect: RegExp; label: string }>> = {
      cutoffGzl: { aspect: /工作量|学生管理|教学|学期/, label: '教学工作量或学生管理的截止' },
      rzCutoff: { aspect: /任职年限|任职/, label: '任职年限的截止' },
    }
    for (const key of overridden) {
      const rule = needsMention[key]
      if (rule && !rule.aspect.test(said)) {
        throw new ScoreInputError(
          `你传了 ${key}=${given[key]}，但用户这句话里没有提到${rule.label}。` +
            `用户只说了业绩认定截止时，只改业绩截止（cutoffYeji）；${key === 'cutoffGzl' ? '教学工作量截止' : '任职年限截止'}保持默认。` +
            `请去掉 ${key} 重新调用。`
        )
      }
    }
  }
  const merged = { ...cfg, ...given }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(merged.cutoffYeji) || !/^\d{4}-\d{2}$/.test(merged.cutoffGzl)) {
    throw new ScoreInputError('截止日期格式应为"年-月-日"（业绩，如 2026-11-30）和"年-月"（工作量，如 2026-11）')
  }
  // 业绩截止改到别的月份时，任职年限与党政管理的"算至月"跟着走（两者在摸底口径里是同一个月）
  merged.rzCutoff = given.rzCutoff ?? (given.cutoffYeji ? given.cutoffYeji.slice(0, 7) : cfg.rzCutoff)
  if (!/^\d{4}-\d{2}$/.test(merged.rzCutoff)) {
    throw new ScoreInputError('任职年限截止月格式应为"年-月"，如 2026-11')
  }
  return merged
}

type Resolved<T> = { value: T; source: string }

const normalizePerson = (input: ScorePersonInput, roster: Map<string, RosterRow>): InternalPerson => {
  if (!input || typeof input !== 'object') {
    throw new ScoreInputError('people 里每一项必须是对象')
  }
  const zgh = String(input.zgh ?? '').trim()
  if (!/^[0-9A-Za-z]{1,20}$/.test(zgh)) {
    throw new ScoreInputError(`工号无法识别：${String(input.zgh)}（应为数字/字母组成的工号）`)
  }
  const fromRoster = roster.get(zgh.slice(0, 6))
  const warnings: string[] = []
  const unparseable: string[] = []
  const given = (value: unknown): string | null => {
    const text = value === undefined || value === null ? '' : String(value).trim()
    return text === '' ? null : text
  }
  /** 解析失败（格式不对或返回 null）一律按"给不出"处理，由调用处决定是提示还是报错 */
  const tryParse = <T>(parser: (value: unknown) => T | null, value: unknown): T | null => {
    try {
      return parser(value)
    } catch {
      return null
    }
  }
  /** 起聘月与拟聘等级：用户的说法优先于名单（用户可能按别的口径提问），与名单不同时记一条提示 */
  const resolveUserFirst = <T>(
    label: string,
    userText: string | null,
    rosterText: string | null,
    parser: (value: unknown) => T | null
  ): Resolved<T> | null => {
    const rosterParsed = rosterText ? tryParse(parser, rosterText) : null
    if (userText) {
      const parsed = tryParse(parser, userText)
      if (parsed !== null) {
        if (rosterParsed !== null && rosterParsed !== parsed) {
          warnings.push(`${label}你给的是「${userText}」，摸底名单里是「${rosterText}」；本表按你给的算`)
        }
        return { value: parsed, source: 'user' }
      }
      if (rosterParsed !== null) {
        warnings.push(`${label}「${userText}」无法识别，已按摸底名单的「${rosterText}」计算`)
        return { value: rosterParsed, source: 'roster' }
      }
      unparseable.push(`${label}「${userText}」`)
      return null
    }
    return rosterParsed !== null ? { value: rosterParsed, source: 'roster' } : null
  }
  /**
   * 岗位序列与系列是名单上的事实，不是用户可随口改的口径：名单里有此人就以名单为准，
   * 调用方传了不同的值只提示不采纳（模型曾给管理辅助序列的人编一个"教学"序列，岗位业绩凭空多出十几分）。
   */
  const resolveRosterFirst = <T>(
    label: string,
    userText: string | null,
    rosterText: string | null,
    parser: (value: unknown) => T | null,
    shown: (value: T) => string
  ): Resolved<T> | null => {
    const rosterParsed = rosterText ? tryParse(parser, rosterText) : null
    if (rosterParsed !== null) {
      const userParsed = userText ? tryParse(parser, userText) : null
      if (userText && userParsed !== null && userParsed !== rosterParsed) {
        warnings.push(`${label}你传的是「${shown(userParsed)}」，但摸底名单里此人是「${shown(rosterParsed)}」；${label}以名单为准，已按名单计算`)
      }
      return { value: rosterParsed, source: 'roster' }
    }
    if (userText) {
      const parsed = tryParse(parser, userText)
      if (parsed !== null) {
        return { value: parsed, source: 'user' }
      }
      unparseable.push(`${label}「${userText}」`)
    }
    return null
  }

  const rdsj = resolveUserFirst('起聘月', given(input.rdsj), fromRoster?.rdsj ?? null, normalizeMonth)
  const level = resolveUserFirst('拟聘等级', given(input.level), fromRoster?.levelText ?? null, parseLevelBand)
  const postSeq = resolveRosterFirst<PostSeq>(
    '岗位序列',
    given(input.postSeq),
    fromRoster?.postSeq ?? null,
    parsePostSeq,
    (v) => POST_SEQ_LABEL[v]
  )
  const series = resolveRosterFirst<Series>(
    '系列',
    given(input.series),
    fromRoster?.series ?? null,
    parseSeries,
    (v) => (v === '02' ? '辅系列' : '主系列')
  )

  if (unparseable.length > 0) {
    throw new ScoreInputError(`工号 ${zgh} 的${unparseable.join('、')}无法识别，请向用户确认后重传`)
  }
  // 缺什么一次列全，免得模型漏一项问一项；并明确要求向用户要，不许替用户假设
  const missingLabels: string[] = []
  if (!rdsj) missingLabels.push('起聘月（如 2023-09）')
  if (!level) missingLabels.push('拟聘等级（如 专技五级）')
  if (!postSeq) missingLabels.push('岗位序列（教学 / 学工 / 管理和辅助）')
  if (!rdsj || !level || !postSeq) {
    throw new ScoreInputError(
      fromRoster
        ? `工号 ${zgh} 在摸底名单里缺${missingLabels.join('、')}，请向用户要`
        : `工号 ${zgh} 不在摸底名单里，以下信息无法自动带出，请逐项向用户询问（不要替用户假设，也不要先出分）：${missingLabels.join('、')}`
    )
  }
  // 系列两边都没有时默认主系列：漏给时按主系列算并声明，避免卡住问答
  const seriesFinal: Resolved<Series> = series ?? { value: '01', source: 'default' }
  return {
    zgh,
    rdsj: rdsj.value,
    dj: level.value,
    postSeq: postSeq.value,
    xl: seriesFinal.value,
    sources: { rdsj: rdsj.source, level: level.source, series: seriesFinal.source, postSeq: postSeq.source },
    warnings,
  }
}

/**
 * 只做入参整理与校验，不查库：正式测算、SQL 比对、单元测试都走这里。
 * 入参不完整或与用户原话对不上时抛 ScoreInputError。
 */
export const prepareScoreRequest = (
  inputs: ScorePersonInput[],
  overrides: ScoreConfigOverrides = {}
): { cfg: RoundConfig; people: InternalPerson[] } => {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ScoreInputError('people 不能为空：至少要有一个人的工号')
  }
  if (inputs.length > MAX_PEOPLE_PER_CALC) {
    throw new ScoreInputError(`一次最多测算 ${MAX_PEOPLE_PER_CALC} 人，请分批调用`)
  }
  const cfg = loadRoundConfig(overrides)
  const roster = loadRoster(cfg)
  return { cfg, people: inputs.map((input) => normalizePerson(input, roster)) }
}

/** 内联名单 CTE，文本与 build_queries.md() 完全一致（保证与摸底生成的 SQL 逐字节相同） */
const buildRosterCte = (people: InternalPerson[], cols: string[]): string => {
  const value = (person: InternalPerson, col: string): string => String((person as unknown as Record<string, unknown>)[col] ?? '')
  const parts = [`SELECT ${cols.map((col) => `'${value(people[0], col)}' ${col}`).join(',')} FROM dual`]
  for (const person of people.slice(1)) {
    parts.push(` UNION ALL SELECT ${cols.map((col) => `'${value(person, col)}'`).join(',')} FROM dual`)
  }
  return `WITH md AS (${parts.join('')})`
}

const fillSql = (template: string, people: InternalPerson[], mdCols: string[], cfg: RoundConfig): string =>
  template
    .split('{MD}')
    .join(buildRosterCte(people, mdCols))
    .split('{CUTOFF_YEJI}')
    .join(cfg.cutoffYeji)
    .split('{CUTOFF_GZL}')
    .join(cfg.cutoffGzl)
    .split('{CQ_YEAR_MAX}')
    .join(cfg.cqYearMax)
    .split('{RZ_CUTOFF}')
    .join(cfg.rzCutoff)
    .split('{FORM_JXGZL}')
    .join(cfg.formJxgzl)
    .split('{ND_MAX}')
    .join(String(Number(cfg.cutoffYeji.slice(0, 4))))

/**
 * 生成某一批次最终发往现场的 SQL（供回归比对与排查口径问题）。
 * 入参处理与正式测算完全相同。
 */
export const buildBatchSql = (
  key: string,
  inputs: ScorePersonInput[],
  overrides: ScoreConfigOverrides = {}
): string => {
  const { cfg, people } = prepareScoreRequest(inputs, overrides)
  const batch = readJson<SqlTemplates>('sql-templates.json').batches[key]
  if (!batch) {
    throw new Error(`测算模板缺少批次 ${key}（scoring/sql-templates.json）`)
  }
  return fillSql(batch.sql, people, batch.mdCols, cfg)
}

/** 简单并发池：中继较慢，限制同时在途请求数 */
const withPool = async <T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> => {
  const results: T[] = new Array(tasks.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= tasks.length) {
          return
        }
        results[index] = await tasks[index]()
      }
    })
  )
  return results
}

type QueryRow = Record<string, unknown>

const queryRows = async (sql: string): Promise<QueryRow[]> => {
  const result = (await runSiteTool('preview_table_data', {
    dataSourceId: config.dataSourceId,
    customSql: sql,
    limit: 100,
  })) as { data?: { rows?: QueryRow[] } } | undefined
  if (!result?.data) {
    throw new Error('现场未返回查询结果（空响应），本次测算中止，不出部分结果')
  }
  return result.data.rows ?? []
}

/** 库内姓名（核对工号是否输错）；查不到不影响测算 */
const lookupNames = async (zghs: string[]): Promise<Map<string, string[]>> => {
  const names = new Map<string, string[]>()
  try {
    const rows = await queryRows(
      `SELECT c_zgh, c_xm FROM DA022_T_JSJBXX WHERE c_zgh IN (${zghs.map((z) => `'${z}'`).join(',')})`
    )
    for (const row of rows) {
      const list = names.get(String(row.C_ZGH)) ?? []
      const name = String(row.C_XM ?? '').trim()
      if (name && !list.includes(name)) {
        list.push(name)
      }
      names.set(String(row.C_ZGH), list)
    }
  } catch {
    // 姓名核对是辅助信息，失败不阻断
  }
  return names
}

export type ScoreResult = {
  config: { cutoffYeji: string; cutoffGzl: string; rzCutoff: string; cqYearMax: string }
  elapsedMs: number
  notes: string[]
  /** 回答纪律：放在结果里而不是只写在技能文件里——模型不一定会去读技能文件，但作答前必然读到本结果 */
  回答要求: string[]
  people: Record<string, unknown>[]
}

type ScoreMap = Record<string, number>

/**
 * 同一入参短时间内的结果缓存：模型偶尔会对同一入参重复调用，白等几十秒；
 * 引擎对同一份库内数据是确定性的，直接返回同一结果即可
 */
const CALC_CACHE_TTL = 10 * 60 * 1000
const calcCache = new Map<string, { at: number; result: ScoreResult }>()

/** 与摸底表逐项对比，只列出不一致的项；摸底表里没有此人则返回 null */
const compareWithBaseline = (
  baseline: ScoreMap | undefined,
  now: Record<string, unknown>,
  label: string
): Record<string, unknown> | null => {
  if (!baseline || baseline['原始分总分'] === undefined) {
    return null
  }
  const diffs = Object.keys(now)
    .filter((name) => name in baseline && Math.abs(Number(now[name]) - (baseline[name] ?? 0)) >= 0.0055)
    .map((name) => ({ 项: name, 摸底表: fx(baseline[name] ?? 0), 现在: fx(Number(now[name])) }))
  return {
    表: label,
    原始分总分: { 摸底表: fx(baseline['原始分总分']), 现在: fx(Number(now['原始分总分'])) },
    一致: diffs.length === 0,
    差异项: diffs,
  }
}

const sourceText = (source: string): string =>
  source === 'user' ? '用户给的' : source === 'roster' ? '取自摸底名单' : '默认值'

/**
 * 计算原始分。任一批次查询失败即整体报错——宁可不出结果，也不出一份缺项的分数表。
 * 入参不完整抛 ScoreInputError（由模型据此向用户补问）。
 */
export const calcRawScore = async (
  inputs: ScorePersonInput[],
  overrides: ScoreConfigOverrides = {}
): Promise<ScoreResult> => {
  const started = Date.now()
  const { cfg, people } = prepareScoreRequest(inputs, overrides)
  const cacheKey = JSON.stringify({
    people: people.map((p) => [p.zgh, p.rdsj, p.xl, p.dj, p.postSeq, p.warnings]),
    names: inputs.map((input) => String(input.name ?? '').trim()),
    cutoffs: [cfg.cutoffYeji, cfg.cutoffGzl, cfg.rzCutoff, cfg.cqYearMax],
  })
  const cached = calcCache.get(cacheKey)
  if (cached && Date.now() - cached.at < CALC_CACHE_TTL) {
    return {
      ...cached.result,
      elapsedMs: Date.now() - started,
      notes: [
        ...cached.result.notes,
        '（本次入参与刚才的一次测算完全相同，直接返回同一结果；不需要再算，请据此作答。）',
      ],
    }
  }
  const hasOverride = (['cutoffYeji', 'cutoffGzl', 'rzCutoff'] as const).some(
    (key) => typeof overrides[key] === 'string' && (overrides[key] as string).trim() !== ''
  )
  const templates = readJson<SqlTemplates>('sql-templates.json')
  const roster = loadRoster(cfg)
  const inputByName = new Map(inputs.map((input) => [String(input.zgh ?? '').trim(), input]))

  // 姓名核对与 7 个批次放进同一个并发池（共 4 路在途），既限制对现场的压力，也少等一轮
  type Done =
    | { kind: 'names'; map: Map<string, string[]> }
    | { kind: 'batch'; key: string; rows: QueryRow[] }
  const done = await withPool<Done>(
    [
      async () => ({ kind: 'names', map: await lookupNames([...new Set(people.map((p) => p.zgh))]) }),
      ...BATCH_KEYS.map(
        (key) => async (): Promise<Done> => {
          const batch = templates.batches[key]
          if (!batch) {
            throw new Error(`测算模板缺少批次 ${key}（scoring/sql-templates.json）`)
          }
          try {
            return { kind: 'batch', key, rows: await queryRows(fillSql(batch.sql, people, batch.mdCols, cfg)) }
          } catch (error) {
            // 现场把 SQL 错误包装成笼统的"执行失败"，这里带上批次名便于定位
            throw new Error(
              `测算批次 ${key}（${batch.title}）执行失败：${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
      ),
    ],
    4
  )
  const nameMap = done.find((item) => item.kind === 'names')?.map ?? new Map<string, string[]>()
  const batchResults = done.filter((item): item is Extract<Done, { kind: 'batch' }> => item.kind === 'batch')

  // 每个批次的结果按工号索引
  const byBatch = new Map<string, Map<string, QueryRow>>()
  for (const { key, rows } of batchResults) {
    byBatch.set(key, new Map(rows.map((row) => [String(row.ZGH), row])))
  }
  const pick = (key: string, zgh: string, columns: string[]): number[] => {
    const row = byBatch.get(key)?.get(zgh)
    if (!row) {
      throw new Error(`测算批次 ${key} 的结果里没有工号 ${zgh}，本次测算中止，不出部分结果`)
    }
    return columns.map((column) => num(row[column]))
  }

  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)
  const results: Record<string, unknown>[] = []
  for (const person of people) {
    const { zgh } = person
    const warnings: string[] = [...person.warnings]
    const rzMonths = months(cfg.rzCutoff) - months(person.rdsj) + 1
    if (rzMonths < 0) {
      warnings.push(`起聘月 ${person.rdsj} 晚于截止月 ${cfg.rzCutoff}，任职年限按 0 计`)
    }
    const rznx = r2(Math.max(rzMonths, 0) * 0.1)
    const xlf = pick('b1', zgh, ['XLF'])[0]
    const q = pick('b2', zgh, ['BZ', 'JL', 'NDKH', 'ZCXY'])
    const w = pick('b3', zgh, ['JXGZL', 'CQ', 'JZGZ'])
    const m = pick('b4', zgh, ['BZR', 'LSBZR', 'SX', 'PX', 'JJ'])
    const a = pick('b5', zgh, ['LW', 'JCZZ', 'ZL', 'CGHJ', 'JCJ'])
    const z = pick('b6', zgh, ['ZXKT', 'HXKT', 'CGZH'])
    const g = pick('b7', zgh, ['SJXM', 'JSJS', 'ZYNL', 'ZDXS'])

    const jcf = r2(rznx + xlf)
    const gzzlf = r2(sum(q))
    const gzlf = r2(sum(w) + sum(m))
    const zygzf = r2(sum(a) + sum(z))
    // 岗位业绩按岗位序列取两项（评议类两项当轮未开展按 0）：教学=实践项目+大赛，学工=职业能力+指导竞赛，管理和辅助=0
    const gwItems = [0, 0, 0, 0, 0, 0]
    if (person.postSeq === 'JX') {
      gwItems[1] = r2(g[0] + g[1])
    } else if (person.postSeq === 'XG') {
      gwItems[3] = r2(g[2] + g[3])
    }
    const gw = r2(gwItems[1] + gwItems[3])
    const total = r2(jcf + gzlf + gzzlf + zygzf + gw)

    // 封顶口径：各类不超过办法上限；岗位业绩先按单项上限截断再求和
    const { caps } = cfg
    const gwCappedItems = gwItems.map((value) => Math.min(value, caps.gwItem))
    const capped = {
      jcf: Math.min(jcf, caps.jcf),
      gzlf: Math.min(gzlf, caps.gzlf),
      gzzlf: Math.min(gzzlf, caps.gzzlf),
      zygzf: Math.min(zygzf, caps.zygzf),
      gw: Math.min(r2(sum(gwCappedItems)), caps.gw),
    }
    const totalCapped = r2(sum(Object.values(capped)))
    const cappedWhere = (
      [
        ['基础分', jcf, capped.jcf],
        ['工作量分', gzlf, capped.gzlf],
        ['工作质量分', gzzlf, capped.gzzlf],
        ['专业工作业绩分', zygzf, capped.zygzf],
        ['岗位工作业绩分', gw, capped.gw],
      ] as const
    )
      .filter(([, raw, cap]) => raw > cap + 0.005)
      .map(([label, raw, cap]) => `${label} ${fx(r2(raw))} 超上限，按 ${fx(cap)} 计`)

    const dbNames = nameMap.get(zgh) ?? []
    const givenName = String(inputByName.get(zgh)?.name ?? '').trim()
    if (givenName && dbNames.length > 0 && !dbNames.includes(givenName)) {
      warnings.push(`你给的姓名是「${givenName}」，但工号 ${zgh} 在库内对应「${dbNames.join('、')}」，请核对工号`)
    }

    results.push({
      zgh,
      name: dbNames[0] ?? fromName(roster, zgh) ?? '',
      系列: person.xl === '02' ? '辅系列' : '主系列',
      岗位序列: POST_SEQ_LABEL[person.postSeq],
      拟聘等级: LEVEL_LABEL[person.dj],
      起聘月: person.rdsj,
      // 入参来源（user=用户给的，roster=取自摸底名单，default=默认值），回答里要如实声明
      入参来源: person.sources,
      原始分: {
        任职年限分: fx(rznx),
        学历分: fx(r2(xlf)),
        基础分小计: fx(jcf),
        本职教学工作量: fx(r2(w[0])),
        辅系列出勤: fx(r2(w[1])),
        党政管理: fx(r2(w[2])),
        班主任: fx(r2(m[0])),
        历史班主任: fx(r2(m[1])),
        实习管理: fx(r2(m[2])),
        培训: fx(r2(m[3])),
        继教: fx(r2(m[4])),
        工作量小计: fx(gzlf),
        表彰: fx(r2(q[0])),
        奖励: fx(r2(q[1])),
        考核优秀: fx(r2(q[2])),
        支持发展: fx(r2(q[3])),
        工作质量小计: fx(gzzlf),
        论文: fx(r2(a[0])),
        教材著作: fx(r2(a[1])),
        纵向课题: fx(r2(z[0])),
        横向课题: fx(r2(z[1])),
        成果转化: fx(r2(z[2])),
        专利软著: fx(r2(a[2])),
        成果奖: fx(r2(a[3])),
        教材奖: fx(r2(a[4])),
        专业业绩小计: fx(zygzf),
        教学评价: '0.00',
        实践项目与大赛: fx(gwItems[1]),
        学工考核: '0.00',
        职业能力与指导竞赛: fx(gwItems[3]),
        岗位工作考核: '0.00',
        服务质量考核: '0.00',
        岗位业绩小计: fx(gw),
        民主测评: '0.00',
        领导评议: '0.00',
        原始分总分: fx(total),
      },
      封顶后: {
        基础分: fx(capped.jcf),
        工作量分: fx(capped.gzlf),
        工作质量分: fx(capped.gzzlf),
        专业工作业绩分: fx(capped.zygzf),
        岗位业绩分: fx(capped.gw),
        总分: fx(totalCapped),
        被截断项: cappedWhere,
      },
      // 现成的口径声明，让模型照抄：它自己拼的时候曾把"教学工作量截止 2026-06"写成 2026-11
      口径声明:
        `起聘月 ${person.rdsj}（${sourceText(person.sources.rdsj)}）；拟聘等级 ${LEVEL_LABEL[person.dj]}（${sourceText(person.sources.level)}）；` +
        `岗位序列 ${POST_SEQ_LABEL[person.postSeq]}（${sourceText(person.sources.postSeq)}）；系列 ${person.xl === '02' ? '辅系列' : '主系列'}（${sourceText(person.sources.series)}）；` +
        `业绩截止 ${cfg.cutoffYeji}，教学工作量与学生管理类截止 ${cfg.cutoffGzl}，任职年限算至 ${cfg.rzCutoff}（含首尾月）。`,
      提示: warnings,
    })
    // 与摸底表对比：只在此人本就在摸底表里、且本次用的就是摸底口径（没改截止日期）时才可比
    const entry = results[results.length - 1]
    entry['摸底表对比'] = hasOverride
      ? null
      : compareWithBaseline(
          roster.get(zgh.slice(0, 6))?.scores,
          entry['原始分'] as Record<string, unknown>,
          cfg.rosterLabel ?? '摸底表'
        )
  }

  const result: ScoreResult = {
    config: { cutoffYeji: cfg.cutoffYeji, cutoffGzl: cfg.cutoffGzl, rzCutoff: cfg.rzCutoff, cqYearMax: cfg.cqYearMax },
    elapsedMs: Date.now() - started,
    notes: [
      '分数由测算引擎按与摸底测算相同的算法从库内审批通过的申报记录算出，不是估算。',
      `任职年限：起聘月至 ${cfg.rzCutoff}，含首尾月，每月 0.1 分。业绩截止 ${cfg.cutoffYeji}；教学工作量、学生管理类截止 ${cfg.cutoffGzl}。`,
      '评议类六项（教学评价/学工考核/岗位工作考核/服务质量考核/民主测评/领导评议）当轮未开展，按 0 计入。',
      '岗位业绩按岗位序列取两项：教学序列=教学实践项目+大赛，学工序列=职业能力提升+指导学生竞赛，管理和辅助序列=0。',
      `原始分不封顶（与摸底表口径一致）；封顶后按办法各类上限截断：基础${cfg.caps.jcf}/工作量${cfg.caps.gzlf}/工作质量${cfg.caps.gzzlf}/专业业绩${cfg.caps.zygzf}/岗位业绩${cfg.caps.gw}（两项各不超过${cfg.caps.gwItem}）。`,
      '每个人的"摸底表对比"给出与摸底测算表是否一致及差异项（本次改过截止日期时为 null，不可比）。',
    ],
    回答要求: [
      '照本结果出表：数字原样抄（已统一保留两位小数）；口径说明直接照抄每人的"口径声明"那一行——它已写明各项入参的来源和所用截止日期，不必再另写一段"入参来源"；不要自己另行推算截止日期。',
      '本结果就是最终分数，不要对同一入参重复测算。',
      '只写本结果里的数字。不要引用、推算或编造"上次""之前""另一版本"的分数来对比；要比对就用"摸底表对比"里的内容，并说明那是摸底测算表的数。',
      '不对分数大小下"异常""不可能""远高于其他人"这类结论。觉得某个数很大，只陈述数值并建议人工核对原始申报记录。',
      '逐条记录需要时再用 get_score_detail 取；只列记录，不逐条标分，不写自己的加总算式。',
      '不说没有在本次对话里查到的库内情况。',
      '对用户说人话：不出现表名、视图名、字段名等技术词，也不要把内部工作备注的措辞（如"核实日期""备忘""口径为"）说给用户。',
    ],
    people: results,
  }
  calcCache.set(cacheKey, { at: Date.now(), result: structuredClone(result) })
  return result
}

const fromName = (roster: Map<string, RosterRow>, zgh: string): string | undefined =>
  roster.get(zgh.slice(0, 6))?.name || undefined
