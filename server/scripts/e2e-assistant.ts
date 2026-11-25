/**
 * 端到端回放：用老师会用的自然问法问助手（经 BFF），把回答与测算引擎的标准答案逐项比对。
 *
 * 与 regress 的分工：regress 只验证"引擎算得对不对"；本脚本验证"助手用得对不对"——
 * 模型是否调了算分工具、有没有替用户编入参、数字是否照抄引擎、有没有把过程说明或英文泄漏给用户。
 * 工具入口的参数处理、模型自行编参数这类问题，只有这种回放才暴露得出来。
 *
 * 前置：BFF 已启动（默认 http://localhost:8787，可用环境变量 BFF_URL 覆盖）。全程走现场库，约 8~10 分钟。
 * 用法: npm --prefix server run e2e [-- --only A,B] [-- --out 报告.txt]
 * 退出码：有检查项不通过为 1。
 */
import { writeFileSync } from 'node:fs'
import { connectMcp } from '../src/mcp.js'
import { calcRawScore, type ScorePersonInput } from '../src/scoring.js'

const bffUrl = process.env.BFF_URL ?? 'http://localhost:8787'
const DSML = '<\uFF5C\uFF5C'
/** 与 agent.ts 的 TOOL_STATUS_TEXT 开头保持一致 */
const TOOL_STATUS_PREFIX = '以下内容依据库内审批通过的申报记录'

type Case = {
  id: string
  title: string
  prompt: string
  /** 引擎算标准答案用的入参；null 表示这题不该出分 */
  expect: ScorePersonInput[] | null
  expectOverrides?: { cutoffYeji?: string }
  /** 只比对这些单项 */
  only?: string[]
  /** 不需要查数据的普通问答 */
  plain?: boolean
}

const cases: Case[] = [
  {
    id: 'A', title: '李斐斐（不在主档·管理辅助），原始问法',
    prompt: '李斐斐100119拟聘岗位：专业技术五级岗位 起聘时间：2023-09。业绩认定截止时间：26.10.31日。核对这个老师的原始分明细项和原始分总分',
    expect: [{ zgh: '100119', rdsj: '2023-09', level: '专业技术五级岗位' }],
  },
  {
    id: 'B', title: '姜爽，截止日期改为 2026 年 11 月（没说岗位序列，不该被替她猜）',
    prompt: '姜爽 100115 竞聘岗位 专技5级 起聘时间2023-09 业绩认定截止时间 2026年11月 重新测算一下原始分数细项和总和',
    expect: [{ zgh: '100115', rdsj: '2023-09', level: '专技5级' }], expectOverrides: { cutoffYeji: '2026-11-30' },
  },
  {
    id: 'C', title: '冯玉静（教学序列，岗位业绩很大，考封顶口径）',
    prompt: '帮我算下冯玉静老师（100153）的分数，她竞聘专业技术七级岗位，起聘时间2019年7月',
    expect: [{ zgh: '100153', rdsj: '2019-07', level: '专业技术七级岗位' }],
  },
  {
    id: 'D', title: '马军元（学工序列）',
    prompt: '马军元 100104 专技九级 起聘2022-07 测算原始分',
    expect: [{ zgh: '100104', rdsj: '2022-07', level: '专技九级' }],
  },
  {
    id: 'E', title: '于洋（辅系列，也不在主档）',
    prompt: '于洋 100167 竞聘辅系列专业技术七级岗位 起聘时间2016-07 算一下原始分',
    expect: [{ zgh: '100167', rdsj: '2016-07', level: '辅系列专业技术七级岗位' }],
  },
  {
    id: 'F', title: '杨清（摸底名单里没有，什么信息都没给）——应当追问，不能编数',
    prompt: '帮我算一下杨清 100393 的职称评聘分数',
    expect: null,
  },
  {
    id: 'G', title: '李斐斐——追问单项怎么来的',
    prompt: '李斐斐 100119 竞聘专技五级 起聘2023-09，她的党政管理分是怎么来的？',
    expect: [{ zgh: '100119', rdsj: '2023-09', level: '专技五级' }], only: ['党政管理'],
  },
  {
    id: 'H', title: '普通问答，不需要查数据——确认回答正常流出',
    prompt: '你能帮我查些什么？',
    expect: null, plain: true,
  },
]

type Block = { type: string; name?: string; text: string }
type ScoreMap = Record<string, number>

const parseArgs = (): { only: Set<string> | null; out: string | null } => {
  const argv = process.argv.slice(2)
  const valueOf = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  const only = valueOf('--only')
  return { only: only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null, out: valueOf('--out') }
}

const parseSse = (text: string): { list: Block[]; stop: string } => {
  const blocks: Record<number, Block> = {}
  let stop = ''
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data: '))
    if (!dataLine) {
      continue
    }
    let evt: Record<string, unknown> & { type?: string }
    try {
      evt = JSON.parse(dataLine.slice(6))
    } catch {
      continue
    }
    const index = Number(evt.index)
    const content = evt.content_block as { type?: string; name?: string } | undefined
    const delta = evt.delta as { type?: string; text?: string; partial_json?: string } | undefined
    if (evt.type === 'content_block_start' && content) {
      blocks[index] = { type: content.type ?? '', name: content.name, text: '' }
    } else if (evt.type === 'content_block_delta' && delta && blocks[index]) {
      if (delta.type === 'text_delta') blocks[index].text += delta.text ?? ''
      if (delta.type === 'input_json_delta') blocks[index].text += delta.partial_json ?? ''
    } else if (evt.type === 'message_delta') {
      stop = String((evt.delta as { stop_reason?: string } | undefined)?.stop_reason ?? '')
    }
  }
  return { list: Object.values(blocks), stop }
}

/** 引擎给的数（两位小数的文本）在回答里出现成哪种写法都算出现：41.25 / 41.250 / 10 / 10.00 */
const formats = (value: unknown): string[] => {
  const number = Number(value)
  const set = new Set([number.toFixed(2), String(number)])
  if (Number.isInteger(number)) {
    set.add(String(number))
  }
  return [...set]
}

/** 模型传入的岗位序列写法 → 与引擎输出一致的名称 */
const seqLabel = (value: unknown): string => {
  const text = String(value)
  if (/教学/.test(text)) return '教学序列'
  if (/学工/.test(text)) return '学工序列'
  if (/管理|管辅/.test(text)) return '管理和辅助序列'
  return text
}

const main = async (): Promise<void> => {
  const args = parseArgs()
  const selected = cases.filter((c) => !args.only || args.only.has(c.id))

  // 标准答案直接由引擎算出（不经模型），默认口径的合成一次调用
  await connectMcp()
  const expected = new Map<string, { person: Record<string, unknown>; config: Record<string, string> }>()
  const normalCases = selected.filter((c) => c.expect && !c.expectOverrides)
  const normalPeople = [...new Map(normalCases.flatMap((c) => c.expect ?? []).map((p) => [p.zgh, p])).values()]
  if (normalPeople.length > 0) {
    const result = await calcRawScore(normalPeople)
    for (const person of result.people) {
      expected.set(`${person.zgh}|`, { person, config: result.config })
    }
  }
  for (const c of selected.filter((item) => item.expectOverrides)) {
    // 引擎会核对截止日期有没有用户原话依据，这里把用例的问法作为原话传入（与助手实际调用时一致）
    const result = await calcRawScore(c.expect ?? [], { ...c.expectOverrides, userSaid: c.prompt })
    const person = result.people[0]
    if (person) {
      expected.set(`${person.zgh}|${c.id}`, { person, config: result.config })
    }
  }

  const lines: string[] = [`BFF：${bffUrl}`, '']
  let failedChecks = 0
  /** 已输出到的行号：每跑完一个用例就把新增部分输出并落盘，中途被打断也留下已完成的部分 */
  let flushed = 0
  const flush = (): void => {
    process.stdout.write(`${lines.slice(flushed).join('\n')}\n`)
    flushed = lines.length
    if (args.out) {
      writeFileSync(args.out, lines.join('\n') + '\n', 'utf8')
    }
  }
  for (const c of selected) {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 7 * 60 * 1000)
    let text = ''
    let firstTextMs: number | null = null
    let firstToolMs: number | null = null
    let failure = ''
    try {
      const response = await fetch(`${bffUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'intranet' },
        body: JSON.stringify({
          model: 'x',
          system: 'x',
          stream: true,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: c.prompt }],
        }),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        failure = `HTTP ${response.status}`
      } else {
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let tail = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          const chunk = decoder.decode(value, { stream: true })
          text += chunk
          tail += chunk
          let cut = tail.indexOf('\n\n')
          while (cut >= 0) {
            const frame = tail.slice(0, cut)
            tail = tail.slice(cut + 2)
            if (firstToolMs === null && frame.includes('"content_block_start"') && frame.includes('"tool_use"')) {
              firstToolMs = Date.now() - started
            }
            // 服务端在工具调用前发的那行说明不算"文字流出"，它是有意给的等待反馈
            const isAnswerText = frame.includes('"type":"text_delta"') && !frame.includes(TOOL_STATUS_PREFIX)
            if (firstTextMs === null && isAnswerText) {
              firstTextMs = Date.now() - started
            }
            cut = tail.indexOf('\n\n')
          }
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
    const seconds = Math.round((Date.now() - started) / 1000)
    if (failure) {
      failedChecks += 1
      lines.push(`===== ${c.id}. ${c.title} =====`, `请求失败：${failure}（${seconds}s）`, '')
      flush()
      continue
    }

    const { list, stop } = parseSse(text)
    const tools = list.filter((b) => b.type === 'tool_use')
    const answer = list.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    const verdicts: string[] = []
    const judge = (ok: boolean, label: string, detail = ''): void => {
      if (!ok) {
        failedChecks += 1
      }
      verdicts.push(`${ok ? '通过' : '不通过'}  ${label}${detail ? `：${detail}` : ''}`)
    }

    // 工具调用之前不应有任何文字流出（说明文字闸门）
    const leakDetail =
      firstTextMs !== null && firstToolMs !== null && firstTextMs < firstToolMs
        ? `文字比首个工具调用早 ${firstToolMs - firstTextMs}ms`
        : ''
    judge(leakDetail === '', '工具调用之前没有文字流出', leakDetail)
    // 说明文字闸门生效后，调工具的那一轮没有任何文字；服务端会在第一个工具调用前发一行说明，避免等待期间页面空白
    judge(
      firstToolMs === null || answer.includes(TOOL_STATUS_PREFIX),
      '调用了工具时开头有一行说明（等待期间页面上不是空白）'
    )
    judge(!answer.includes(DSML), '回答里没有伪调用标记')
    const english = answer.split('\n').filter((line) => !/[\u4e00-\u9fa5]/.test(line) && (line.match(/[A-Za-z]{3,}/g) ?? []).length >= 6)
    judge(english.length === 0, '回答里没有英文过程说明', english[0]?.slice(0, 80))
    judge(!/(回复|请回复|请选择).{0,6}(继续|方案)/.test(answer), '没有让用户"回复继续/选方案"')

    const exp = c.expect ? expected.get(`${c.expect[0]?.zgh}|${c.expectOverrides ? c.id : ''}`) : null

    // 模型不该替用户补它没说的入参。岗位序列若与摸底名单一致，服务端会按名单计算、结果不受影响，只算轻微；
    // 与名单不同（真编了一个）或用户没说截止日期却传了截止日期，才是会算错分的问题
    const mentionsSeq = /教学|学工|管理/.test(c.prompt)
    const mentionsDate = /\d{2,4}\s*[年.\-/]\s*\d{1,2}|月/.test(c.prompt)
    let fabricated = ''
    for (const tool of tools.filter((b) => b.name === 'calc_raw_score')) {
      let input: { people?: Record<string, unknown>[]; config?: Record<string, unknown> } = {}
      try {
        input = JSON.parse(tool.text)
      } catch {
        continue
      }
      for (const person of input.people ?? []) {
        if (!mentionsSeq && person.postSeq !== undefined) {
          const rosterLabel = exp ? String(exp.person['岗位序列']) : ''
          if (seqLabel(person.postSeq) !== rosterLabel) {
            fabricated = `岗位序列「${String(person.postSeq)}」用户没说，且与摸底名单（${rosterLabel || '无'}）不同`
          }
        }
      }
      if (!mentionsDate && input.config && Object.values(input.config).some((v) => v !== undefined)) {
        fabricated = `截止日期「${JSON.stringify(input.config)}」用户没说`
      }
    }
    judge(fabricated === '', '没有替用户编入参（岗位序列、截止日期）', fabricated)
    judge(!/ZJB_|V_RSC_|DA\d{3}_|ss_process|ANNUAL_/i.test(answer), '回答里没有表名等技术词')
    judge(tools.filter((b) => b.name === 'calc_raw_score').length <= 2, '算分工具没有多余的重调（不超过 2 次）')
    if (exp && !c.plain) {
      judge(tools.some((b) => b.name === 'calc_raw_score'), '调用了算分工具 calc_raw_score')
      const raw = exp.person['原始分'] as Record<string, unknown>
      const cap = exp.person['封顶后'] as Record<string, unknown>
      // 口径声明里的两个截止日期必须与引擎实际使用的一致：模型曾把"教学工作量截止 2026-06"说成 2026-11。
      // 只查完整出表的用例；只问某个单项的题不要求带整行口径声明
      if (!c.only) {
        judge(
          answer.includes(`业绩截止 ${exp.config.cutoffYeji}`) && answer.includes(`截止 ${exp.config.cutoffGzl}`),
          '口径声明里的两个截止日期与引擎一致',
          `应为 业绩截止 ${exp.config.cutoffYeji}、教学工作量与学生管理类截止 ${exp.config.cutoffGzl}`
        )
      }
      // 引擎输出的分数是两位小数的文本，"0.00" 也是字符串，要按数值判断是否为零
      const names = c.only ?? Object.keys(raw).filter((k) => Number(raw[k]) !== 0)
      const missing = names.filter((name) => !formats(raw[name]).some((s) => answer.includes(s)))
      judge(missing.length === 0, `各项分数与引擎一致（${names.length} 项）`, missing.map((name) => `${name}=${raw[name]}`).join('，'))
      if (!c.only) {
        judge(formats(raw['原始分总分']).some((s) => answer.includes(s)), '原始分总分', `应为 ${raw['原始分总分']}`)
        judge(formats(cap['总分']).some((s) => answer.includes(s)), '封顶后总分', `应为 ${cap['总分']}`)
      }
    }
    if (c.id === 'F') {
      // 信息不全：必须追问，不能出分
      judge(/起聘/.test(answer), '追问了起聘月')
      judge(!/原始分总分[：:]\s*\d/.test(answer), '没有出分')
    }
    if (c.id === 'G') {
      // 回归：有一轮没调算分工具、照记录自己算，把属于工作量分的"党政管理"说成了"基础分"
      judge(!/(计入|属于|归[入属])[^。\n]{0,16}基础分/.test(answer), '没有把党政管理分说成基础分（它属于工作量分）')
    }
    if (c.plain) {
      judge(answer.trim().length > 10, '普通问答有回答')
    }

    lines.push(
      `===== ${c.id}. ${c.title} =====`,
      `问：${c.prompt}`,
      `耗时 ${seconds}s｜停止原因 ${stop}｜首个工具调用 ${firstToolMs === null ? '无' : `${firstToolMs}ms`}｜首个文字 ${firstTextMs === null ? '无' : `${firstTextMs}ms`}`,
      `工具调用 ${tools.length} 次：${tools.map((b) => b.name).join(' → ') || '无'}`,
      ...verdicts,
      `--- 回答 ---`,
      answer,
      ''
    )
    flush()
  }
  lines.push(failedChecks === 0 ? '全部检查项通过' : `不通过的检查项：${failedChecks}`)
  flush()
  process.exit(failedChecks === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('端到端回放执行出错：', error instanceof Error ? error.message : error)
  process.exit(1)
})
