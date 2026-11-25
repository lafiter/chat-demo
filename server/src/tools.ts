import { config } from './config.js'
import { runSiteTool } from './mcp.js'
import { calcRawScore, type ScoreConfigOverrides, type ScorePersonInput } from './scoring.js'
import { readSkillFile } from './skills.js'

/** 暴露给模型的工具（Anthropic 格式）：技能读取 + 现场数据只读查询 */

export type ToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** 业绩类「主表 + _RY 参与人子表 + ss_process」统一取数模板（2026-11 经 user_tables/实测验证的通用模式） */
const ryJoin = (table: string, zgh: string): string =>
  `SELECT t.*, m.ZGH ry_zgh FROM ${table} t, ${table}_RY m, ss_process p ` +
  `WHERE p.id=t.id AND m.PROCESS_ID=t.id AND m.ZGH='${zgh}' AND p.process_status||p.process_result='FINISHAGREE'`

/**
 * 高层取数工具的模板 SQL：全部来自技能包 references/query-patterns.md、技能脚本及实测验证过的
 * 字段名/表名。口径（起聘月/截止日）不在此过滤——返回原始记录，由模型按当轮口径复算，
 * 这样用户改口径时无需改模板。
 * 注意：V_RSC_* 计分视图（共 53 个）全部依赖岗位主档 V_RSC_GWJP_JSXX，不在主档的人视图项恒为 0，
 * 所以复算一律以原始表模板为准，视图类模板（party_gov/evaluation）只作参照。
 */
const SCORE_ITEMS: Record<string, { label: string; sql: (value: string) => string }> = {
  register: {
    label:
      '岗位主档 = 一个固定批次的职称评聘申报名册（姓名/拟聘等级/起算月，起算月含人工个别覆盖值）。' +
      '返回 0 行 = 该人不在主档：全部 V_RSC_* 计分视图口径恒为 0（属已知数据现象，不是没有业绩），' +
      '必须改用 work_history / annual_review / term_review 等原始表模板复算，不要排查视图定义',
    sql: (v) => `SELECT zgh, xm, rdsj, rdsj_up FROM V_RSC_GWJP_JSXX WHERE zgh='${v}'`,
  },
  education: {
    label: '学历学位（视图不依赖岗位主档，SCORE 即学历分）',
    sql: (v) => `SELECT t.* FROM V_RSC_XL t WHERE t.zgh='${v}'`,
  },
  work_history: {
    label:
      '工作经历原始记录（仅审批通过）。党政管理分由此复算：取起聘月之后的重叠月份（含首尾），' +
      '月数/12×职务级别系数（院领导3 / 中层正职2.4 / 中层副职1.8 / 科员·班主任·辅导员·团总支书记·系办主任·教辅人员1.2）；' +
      '同级前后相接的段必须合并成一段计算',
    sql: (v) =>
      `SELECT t.zgh, t.xm, t.bm, t.zwjb, t.zw, t.kssj, t.jssj FROM DA022_T_JS_GZJL t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE' ` +
      `AND (t.jssj>t.kssj OR t.jssj IS NULL) ORDER BY t.kssj`,
  },
  annual_review: {
    label: '年度考核原始记录（仅审批通过）。考核优秀分：起聘后 KHDC=优秀 每次 2 分',
    sql: (v) =>
      `SELECT t.zgh, t.xm, t.nd, t.khdc FROM DA022_YJ_NDKH t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE' ORDER BY t.nd`,
  },
  term_review: {
    label: '聘期考核原始记录（仅审批通过）。KHDC=优秀 每次 4 分',
    sql: (v) =>
      `SELECT t.zgh, t.xm, t.nd, t.khdc FROM DA022_YJ_PQKH t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE' ORDER BY t.nd`,
  },
  identity: {
    label: '教师基本信息全行（含姓名/部门/学历三字段）',
    sql: (v) => `SELECT * FROM DA022_T_JSJBXX WHERE c_zgh='${v}'`,
  },
  roster: {
    label: '职称评聘申报表全部记录（不区分批次，可传工号或姓名，重名核对用；有无申报单、在哪个批次以此为准）',
    sql: (v) => `SELECT c_zgh, xm, series_id, jslb FROM da129_zcps WHERE c_zgh='${v}' OR xm='${v}'`,
  },
  appointment: {
    label: '聘任史原始记录（C_M7XD 起始月 / C_OVUZ 聘任等级，起聘月核实用；主表关联子表）',
    sql: (v) =>
      `SELECT g.C_M7XD, g.C_OVUZ, g.C_FOPB, g.C_NM0S, g.C_Q1LS FROM DA022_T_JSJBXX_G_5O1I g, ss_process p, DA022_T_JSJBXX s ` +
      `WHERE g.PROCESS_ID=p.id AND p.id=s.id AND s.c_zgh='${v}'`,
  },
  party_gov: {
    label: '党政管理（视图口径，仅审批通过）。视图依赖岗位主档：register 返回 0 行时本项恒为 0，须改用 work_history 复算',
    sql: (v) => `SELECT * FROM V_RSC_JZGZ_MX WHERE zgh='${v}'`,
  },
  workload: {
    label: '本职教学工作量（按学期，仅审批通过）',
    sql: (v) =>
      `SELECT t.xn, t.xq, t.jxgzl, p.process_status||p.process_result st FROM DA022_YJ_JXGZL t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.form_code='11981c45708c482ca98370e31ee99568' ` +
      `AND p.process_status||p.process_result='FINISHAGREE'`,
  },
  commendation: {
    label: '表彰与通报表扬原始记录（含按办法预折算的单条分值，仅审批通过；计分时同年同类别取最高）',
    sql: (v) =>
      `SELECT t.zgh, t.bzmc, t.bzdj, t.bzlb, t.bzsj, ` +
      `CASE WHEN t.bzdj LIKE '%国%' THEN 16 WHEN t.bzdj LIKE '%省%' THEN 12 WHEN t.bzdj LIKE '%厅级%' THEN 8 ` +
      `WHEN t.bzdj LIKE '%市级%' THEN 4 WHEN t.bzdj LIKE '%校%' THEN 2 END fz ` +
      `FROM DA022_YJ_BZ t, ss_process p WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE' ` +
      `UNION ALL SELECT t.zgh, t.tbmc, t.bydj, '通报表扬', t.tbsj, ` +
      `CASE WHEN t.bydj LIKE '%国%' THEN 8 WHEN t.bydj LIKE '%省%' THEN 6 WHEN t.bydj LIKE '%市、厅%' THEN 4 ` +
      `WHEN t.bydj LIKE '%市局、委%' THEN 2 WHEN t.bydj LIKE '%校%' THEN 1 END ` +
      `FROM DA022_YJ_BZ_BY t, ss_process p WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE'`,
  },
  paper: {
    label: '论文原始记录（含级别/发表时间/位次，仅审批通过；C/D/E 限 2 篇取最高）',
    sql: (v) =>
      `SELECT t.lwmc, t.jb, t.fbsj, m.wc FROM DA022_YJ_KY_LW t, DA022_YJ_KY_LW_RY m, ss_process p ` +
      `WHERE p.id=t.id AND m.process_id=t.id AND m.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE'`,
  },
  textbook: {
    label: '教材著作原始记录（主表全行，仅审批通过；非规划教材限 2 部，主审同级别第一主编减半）',
    sql: (v) => ryJoin('DA022_YJ_KY_JCZZ', v),
  },
  vertical_project: {
    label: '纵向课题原始记录（主表全行，仅审批通过；分值查码表 ZJB_RSC_DM，副高校级限 2 项）',
    sql: (v) => ryJoin('DA022_YJ_KT_ZXKT', v),
  },
  horizontal_project: {
    label: '横向课题原始记录（主表全行，仅审批通过；须技术服务认定 SFTGJDHYS=是 才计分）',
    sql: (v) => ryJoin('DA022_YJ_KY_HXKT', v),
  },
  patent: {
    label: '专利原始记录（主表全行，仅审批通过；发明4/实用·外观2/软著1 × 位次系数）',
    sql: (v) => ryJoin('DA022_YJ_KY_ZL', v),
  },
  achievement_award: {
    label: '成果奖/教材奖原始记录（主表全行，仅审批通过；CGLX=教材 为教材奖；分值查码表）',
    sql: (v) => ryJoin('DA022_YJ_KY_CGHJ', v),
  },
  transformation: {
    label: '成果转化原始记录（主表全行含档次DC/到账金额DZJE，仅审批通过；得分=到账万元×档次分×贡献度）',
    sql: (v) => ryJoin('DA022_YJ_KY_CGZH', v),
  },
  training: {
    label: '培训/继教原始记录（仅审批通过；考核等次为空按系数 1）',
    sql: (v) =>
      `SELECT t.zgh, t.nd, t.wcpxrs, t.pxxss, t.khdc FROM DA022_YJ_PX t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE'`,
  },
  support: {
    label: '支持学院发展三类原始记录（外派/招生/继教，仅审批通过）',
    sql: (v) =>
      `SELECT '外派' src, t.gzlx, t.kssj, t.jssj, t.ys FROM DA022_YJ_WPGZ t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE' ` +
      `UNION ALL SELECT '招生', t.nd, t.zsrws, t.sjwcs, NULL FROM DA022_YJ_ZSRW t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE' ` +
      `UNION ALL SELECT '继教', t.nd, t.zsrs, NULL, NULL FROM DA022_YJ_JXJYZS t, ss_process p ` +
      `WHERE p.id=t.id AND t.zgh='${v}' AND p.process_status||p.process_result='FINISHAGREE'`,
  },
  evaluation: {
    label: '岗位考核/服务考核/民测评议均值（注意：review_id 为 2025 年度硬编码，换年度须改口径）',
    sql: (v) =>
      `SELECT r.type_, AVG(r.score) avg_score FROM ANNUAL_DA_EVALUATION_RESULT r ` +
      `WHERE r.object_id='${v}' AND r.review_id='2c9000aa94437f44019642ddc3d5000f' GROUP BY r.type_`,
  },
}

/** 取数结果缓存：同一 (item, 工号) 短时间内重复查询直接命中，省中继往返 */
const DETAIL_CACHE_TTL = 10 * 60 * 1000
const detailCache = new Map<string, { at: number; payload: string }>()

/** 简单并发池：中继较慢，全量取数时限制同时在途请求数，避免压垮现场 */
const runWithConcurrency = async <T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> => {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= tasks.length) {
        return
      }
      try {
        results[index] = { status: 'fulfilled', value: await tasks[index]() }
      } catch (error) {
        results[index] = { status: 'rejected', reason: error }
      }
    }
  })
  await Promise.all(workers)
  return results
}

export const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'calc_raw_score',
    description:
      '【只要回答里会出现任何一项分数，就必须先调用本工具——包括"算总分""核对分数"，也包括"某一项分是怎么来的"；' +
      '所有分数以它的输出为准，不要拿申报记录自己按办法算分（曾因此把属于工作量分的项说成基础分）】' +
      '用与摸底测算完全相同的算法，从库内审批通过的申报记录算出原始分明细（与摸底表同版式）和总分，' +
      '同时给出按办法各类上限封顶后的分。' +
      '入参 people（每人）：zgh 工号（必填）；rdsj 起聘月（用户给了必须按用户的传，如 2023-09）；' +
      'level 拟聘等级（如 专技五级）；postSeq 岗位序列（教学 / 学工 / 管理和辅助，决定岗位业绩计哪两项；摸底名单里有此人时以名单为准）；' +
      'series 系列（主系列 / 辅系列）；name 用户给的姓名（可选，用于核对工号）。' +
      '用户没说的入参一律不传（尤其是岗位序列和截止日期，不要替用户猜）：工具会从摸底名单自动回填并注明来源；取不到会报错说明缺什么，这时再向用户要。' +
      '只有用户这句话里明确说了截止日期才传 config。业绩截止、教学工作量截止、任职年限截止是三个独立的口径：' +
      '用户说"业绩认定截止 X"时只传 cutoffYeji（如 2026-11-30）；cutoffGzl（教学工作量/学生管理截止，默认 2026-06）和 rzCutoff 只有用户明确提到时才传。' +
      '服务端会拿用户原话逐项核对，对不上会报错，此时按报错提示修正后重新调用。' +
      '一次最多 100 人。回答时照结果出表，并写明：各项入参的来源（用户给的 / 取自摸底名单 / 默认）、所用截止日期、原始分与封顶后两个总分；返回的"提示"必须原样告知用户。',
    input_schema: {
      type: 'object',
      properties: {
        people: {
          type: 'array',
          description: '要测算的人员，每人一个对象',
          items: {
            type: 'object',
            properties: {
              zgh: { type: 'string', description: '工号' },
              rdsj: { type: 'string', description: '起聘月，如 2023-09（按用户给的传）' },
              level: { type: 'string', description: '拟聘等级，如 专技五级 / 专业技术五级岗位 / 副高7级' },
              postSeq: { type: 'string', description: '岗位序列：教学 / 学工 / 管理和辅助' },
              series: { type: 'string', description: '主系列 / 辅系列' },
              name: { type: 'string', description: '用户提供的姓名（可选）' },
            },
            required: ['zgh'],
          },
        },
        config: {
          type: 'object',
          description: '仅当用户明确指定了不同的截止日期时才传',
          properties: {
            cutoffYeji: { type: 'string', description: '业绩截止日期，如 2026-11-30' },
            cutoffGzl: { type: 'string', description: '教学工作量/学生管理截止月，如 2026-11' },
          },
        },
      },
      required: ['people'],
    },
  },
  {
    name: 'get_score_detail',
    description:
      '【只取原始申报记录，不含分数】要解释某个单项由哪些记录构成时用。' +
      '回答里出现的任何分数都必须来自 calc_raw_score，不要拿这些记录自己按办法算分，也不要自己判断某项属于哪一类、上限多少' +
      '（曾因此把工作量类的"党政管理"说成基础分）。"某一项分是怎么来的"也要先调 calc_raw_score 取分，再用本工具取记录。' +
      '按工号取职称评聘原始申报记录，模板 SQL 已实测验证，不会因列名写错而失败。' +
      '要解释多个单项时用 item=all：一次并行取回全部单项，比逐项调用快。' +
      'item 可选：all(一次取全部单项，推荐) / register(岗位主档=固定批次申报名册，判定视图口径是否可用) / identity(基本信息/学历全行)、' +
      'roster(职称评聘申报表，不分批次，zgh 可传工号或姓名)、appointment(聘任史/起聘月)、education(学历分)、' +
      'work_history(工作经历→党政管理分)、party_gov(党政管理视图口径)、annual_review(年度考核)、' +
      'term_review(聘期考核)、workload(本职教学工作量)、' +
      'commendation(表彰+通报表扬，含预折算分值)、paper(论文含位次)、textbook(教材著作)、' +
      'vertical_project(纵向课题)、horizontal_project(横向课题)、patent(专利)、' +
      'achievement_award(成果奖/教材奖)、transformation(成果转化)、training(培训继教)、' +
      'support(支持学院发展)、evaluation(岗位考核评议，2025年度)。' +
      '返回 { item, results: { 各项: { label, rowCount, rows } 或 { error } } }（rowCount=0 表示无已审批记录，属正常业务结果）。' +
      '起聘月/截止日等窗口口径由你在复算时套用（本工具不过滤时间）。' +
      '未覆盖单项（班主任/历史班主任/竞赛类等）：先 get_table_schema 查表结构，再 query_zcps_sql。',
    input_schema: {
      type: 'object',
      properties: {
        zgh: { type: 'string', description: '工号（roster 项可传姓名）' },
        item: { type: 'string', description: `单项标识：${Object.keys(SCORE_ITEMS).join(' | ')}` },
      },
      required: ['zgh', 'item'],
    },
  },
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
      '执行只读 SQL 查询「表单工作站」数据源（V_RSC_* 计分视图与 DA022_* 业绩申报表）。**取单项分数记录优先用 get_score_detail（模板已验证）**，本工具用于它未覆盖的单项或临时核对。约束：Oracle 11g 语法（分页用 ROWNUM<=n，不支持 FETCH FIRST）；不要加 schema 前缀；只支持单条 SELECT/WITH 语句；最多返回 limit 行（1-100，默认 100）。返回 JSON：{ rowCount, rows }。' +
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
/** 执行工具时可用的会话上下文（由调用方提供，模型无法伪造） */
export type ToolContext = {
  /** 用户当前这句提问的原话：算分工具用它核对模型传入的截止日期有没有依据 */
  userSaid?: string
}

export const executeTool = async (name: string, input: unknown, context: ToolContext = {}): Promise<string> => {
  const args = asRecord(input)
  if (name === 'calc_raw_score') {
    const people = args.people
    if (!Array.isArray(people)) {
      throw new Error('people 必须是数组：[{ zgh, rdsj, level, postSeq, ... }]')
    }
    const config = asRecord(args.config)
    // 只带上模型确实传了的截止日期；没传的保持缺省，不能用空值把默认口径冲掉
    const overrides: ScoreConfigOverrides = { userSaid: context.userSaid }
    for (const key of ['cutoffYeji', 'cutoffGzl', 'rzCutoff'] as const) {
      const value = config[key]
      if (typeof value === 'string' && value.trim()) {
        overrides[key] = value.trim()
      }
    }
    return JSON.stringify(await calcRawScore(people as ScorePersonInput[], overrides))
  }
  if (name === 'get_score_detail') {
    const value = String(args.zgh ?? '').trim()
    const item = String(args.item ?? '').trim()
    if (!/^[0-9A-Za-z\u4e00-\u9fa5]{1,20}$/.test(value)) {
      throw new Error('zgh 必须为 1-20 位工号或姓名（不允许特殊字符）')
    }
    const cacheKey = `${item}:${value}`
    const cached = detailCache.get(cacheKey)
    if (cached && Date.now() - cached.at < DETAIL_CACHE_TTL) {
      return cached.payload
    }
    const fetchItem = async (
      key: string
    ): Promise<string> => {
      const def = SCORE_ITEMS[key]
      if (!def) {
        return JSON.stringify({ item: key, error: `未知 item：${key}` })
      }
      const sql = assertReadOnlySql(def.sql(value))
      try {
        const result = (await runSiteTool('preview_table_data', {
          dataSourceId: config.dataSourceId,
          customSql: sql,
          limit: 100,
        })) as { data?: { rowCount?: number; rows?: unknown[] } }
        const data = result?.data
        if (!data) {
          return JSON.stringify({ item: key, error: '现场未返回数据（空响应），该项本次无法取到' })
        }
        return JSON.stringify({
          item: key,
          label: def.label,
          rowCount: data.rowCount ?? data.rows?.length ?? 0,
          rows: data.rows ?? [],
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return JSON.stringify({ item: key, error: `取数失败：${message}` })
      }
    }
    let payload: string
    if (item === 'all') {
      // 全量并行取数（限并发），单项失败不影响其余，结果一并交卷
      const keys = Object.keys(SCORE_ITEMS)
      const parts = await runWithConcurrency(
        keys.map((key) => () => fetchItem(key)),
        6
      )
      const results: Record<string, unknown> = {}
      keys.forEach((key, index) => {
        const settled = parts[index]
        results[key] =
          settled.status === 'fulfilled'
            ? JSON.parse(settled.value)
            : { item: key, error: String(settled.reason) }
      })
      // 不在岗位主档的人，全部计分视图恒为 0——把这一判断直接告诉模型，
      // 省得它去逐个排查视图定义（实测一次要烧掉约 9 轮工具调用）
      const register = results.register as { rowCount?: number } | undefined
      const viewGap = register?.rowCount === 0
      payload = JSON.stringify({
        item: 'all',
        ...(viewGap
          ? {
              viewGap: true,
              note:
                '该人不在岗位主档 V_RSC_GWJP_JSXX：party_gov、evaluation 等视图项返回 0 属预期现象，不代表没有业绩。' +
                '请直接用 work_history / annual_review / term_review / education 及各业绩原始表模板的结果复算，不要排查视图定义。',
            }
          : {}),
        results,
      })
    } else {
      if (!SCORE_ITEMS[item]) {
        throw new Error(`未知 item：${item}（完整测算请用 all），单项可用：${Object.keys(SCORE_ITEMS).join(' / ')}`)
      }
      payload = await fetchItem(item)
    }
    detailCache.set(cacheKey, { at: Date.now(), payload })
    return payload
  }
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
      const data = result?.data
      if (!data) {
        throw new Error('现场未返回查询结果（空响应）。请缩小查询范围（加 WHERE 条件或降低 limit）后重试。')
      }
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
    if (result === undefined) {
      throw new Error(`未取到表 ${tableName} 的结构（现场空响应），请确认表名无误`)
    }
    return JSON.stringify(result)
  }
  throw new Error(`未知工具：${name}`)
}

/** 聊天日志里对一次工具调用的简述 */
export const describeToolCall = (name: string, input: unknown): string => {
  const args = asRecord(input)
  if (name === 'calc_raw_score') {
    // 日志里只记工号与截止日期，不展开整份入参
    const list = Array.isArray(args.people) ? args.people.map((p) => String(asRecord(p).zgh ?? '?')).join(',') : '?'
    const cfg = asRecord(args.config)
    const extra = Object.entries(cfg)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ')
    return `calc_raw_score(${list}${extra ? ` ${extra}` : ''})`
  }
  if (name === 'query_zcps_sql') {
    const sql = String(args.sql ?? '').replace(/\s+/g, ' ').slice(0, 160)
    return `query_zcps_sql(\`${sql}\`)`
  }
  const brief = Object.entries(args)
    .map(([key, value]) => `${key}=${String(value).slice(0, 80)}`)
    .join(', ')
  return `${name}(${brief})`
}
