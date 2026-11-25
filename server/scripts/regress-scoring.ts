/**
 * 原始分测算回归：用测算引擎重算摸底名单上的所有人，与摸底表逐格对比。
 *
 * 什么时候跑：改了技能包 scoring/ 下的模板或参数、改了 src/scoring.ts、或怀疑现场数据变了。
 * 怎么跑：npm --prefix server run regress
 *   可选：-- --only 100119,100115     只算指定工号
 *         -- --out 报告.txt           把对比报告写成 UTF-8 文本（终端中文乱码时用）
 *         -- --export 新表.csv         把本次测算结果按摸底表版式导出（刷新基准表用）
 *
 * 退出码：测算执行出错为 1；有差异不影响退出码，差异逐条列在报告里，由人判断是数据变化还是算法问题。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from '../src/config.js'
import { connectMcp } from '../src/mcp.js'
import { calcRawScore, parseCsvText, type ScorePersonInput } from '../src/scoring.js'

type Args = { only: Set<string> | null; out: string | null; exportTo: string | null }

const parseArgs = (): Args => {
  const argv = process.argv.slice(2)
  const valueOf = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 ? (argv[index + 1] ?? null) : null
  }
  const only = valueOf('--only')
  return {
    only: only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null,
    out: valueOf('--out'),
    exportTo: valueOf('--export'),
  }
}

const scoringDir = path.join(config.skillsRoot, 'zcps-score-audit', 'scoring')

type ScoreMap = Record<string, unknown>

const csvCell = (value: string): string => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

const main = async (): Promise<void> => {
  const args = parseArgs()
  // 基准表就是本轮参数里登记的摸底名单
  const roundConfig = JSON.parse(readFileSync(path.join(scoringDir, 'round-config.json'), 'utf8').replace(/^\uFEFF/, '')) as {
    rosterCsv?: string
  }
  const baselinePath = path.resolve(scoringDir, roundConfig.rosterCsv ?? '')
  const [header, ...body] = parseCsvText(readFileSync(baselinePath, 'utf8'))
  if (!header) {
    throw new Error(`基准表没有表头：${baselinePath}`)
  }
  const col = (name: string): number => {
    const index = header.indexOf(name)
    if (index < 0) {
      throw new Error(`基准表缺少列「${name}」`)
    }
    return index
  }
  const baseCols = header.slice(col('原始分总分'))
  const infoCols = header.slice(0, col('原始分总分'))

  const entries = body
    .filter((cells) => cells.some((c) => c.trim() !== ''))
    .map((cells) => {
      // 工号口径与摸底名单一致：去掉小数部分、取前 6 位
      const zgh = String(cells[col('工号')] ?? '').split('.')[0].slice(0, 6)
      return {
        zgh,
        cells,
        input: {
          zgh,
          name: cells[col('姓名')] ?? '',
          rdsj: cells[col('起聘时间')] ?? '',
          level: cells[col('拟竞聘岗位')] ?? '',
          series: cells[col('序列')] ?? '',
          postSeq: cells[col('岗位序列')] ?? '',
        } as ScorePersonInput,
      }
    })
    .filter((entry) => entry.zgh && (!args.only || args.only.has(entry.zgh)))

  await connectMcp()
  const started = Date.now()
  const results = new Map<string, Record<string, unknown>>()
  // 中继单次查询最多回 100 行，按 100 人分批
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    const result = await calcRawScore(chunk.map((entry) => entry.input))
    for (const person of result.people) {
      results.set(String(person.zgh), person)
    }
  }
  const elapsed = Math.round((Date.now() - started) / 1000)

  const lines: string[] = [
    `基准表：${path.basename(baselinePath)}`,
    `名单 ${entries.length} 人，耗时 ${elapsed} 秒`,
  ]
  let samePeople = 0
  let cells = 0
  let sameCells = 0
  const exportRows: string[][] = []
  for (const entry of entries) {
    const person = results.get(entry.zgh)
    if (!person) {
      lines.push(`${entry.zgh} ${entry.input.name}：引擎没有返回结果`)
      continue
    }
    const scores = person['原始分'] as ScoreMap
    const diffs: string[] = []
    const scoreTexts: string[] = []
    for (const name of baseCols) {
      const raw = scores[name]
      if (raw === undefined) {
        throw new Error(`引擎输出缺少「${name}」列`)
      }
      cells += 1
      const baseText = (entry.cells[col(name)] ?? '').trim()
      const base = baseText === '' ? 0 : Number(baseText)
      // 引擎输出的分数是两位小数的文本，按数值比对
      const got = Number(raw)
      if (Math.abs(got - base) < 0.0055) {
        sameCells += 1
      } else {
        diffs.push(`${name}：基准 ${base} / 现在 ${got}`)
      }
      scoreTexts.push(got.toFixed(2))
    }
    if (diffs.length === 0) {
      samePeople += 1
    } else {
      const hints = (person['提示'] as string[] | undefined) ?? []
      const series = entry.cells[col('序列')] ?? ''
      const seq = entry.cells[col('岗位序列')] ?? ''
      const rdsj = entry.cells[col('起聘时间')] ?? ''
      lines.push(`${entry.zgh} ${entry.input.name}（${series}·${seq}，起聘 ${rdsj}）→ ${diffs.join('；')}${hints.length ? `｜提示：${hints.join('；')}` : ''}`)
    }
    exportRows.push([...infoCols.map((name) => entry.cells[col(name)] ?? ''), ...scoreTexts])
  }
  lines.splice(2, 0, `逐格完全一致 ${samePeople} 人，有差异 ${entries.length - samePeople} 人；分数单元格一致 ${sameCells}/${cells}`, '')
  const report = lines.join('\n') + '\n'
  process.stdout.write(`${report}\n`)
  if (args.out) {
    writeFileSync(args.out, report, 'utf8')
    process.stdout.write(`报告已写入 ${args.out}\n`)
  }
  if (args.exportTo) {
    const csv = [header, ...exportRows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
    writeFileSync(args.exportTo, `\uFEFF${csv}`, 'utf8')
    process.stdout.write(`测算结果已导出 ${args.exportTo}\n`)
  }
  process.exit(0)
}

main().catch((error) => {
  console.error('回归执行出错：', error instanceof Error ? error.message : error)
  process.exit(1)
})
