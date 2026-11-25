/**
 * 入参防线的快速测试（不查库，秒级）。
 * 用法: npm --prefix server run test:guards
 */
import { prepareScoreRequest, ScoreInputError } from '../src/scoring.js'

let failed = 0
const check = (name: string, run: () => boolean): void => {
  const ok = run()
  if (!ok) {
    failed += 1
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
/** 期望抛 ScoreInputError，且报错里包含给定关键词 */
const expectError = (run: () => unknown, keyword: string): boolean => {
  try {
    run()
  } catch (error) {
    return error instanceof ScoreInputError && error.message.includes(keyword)
  }
  return false
}

const undef = { cutoffYeji: undefined, cutoffGzl: undefined, rzCutoff: undefined } as Record<string, undefined>

check('覆盖项全是 undefined 时按默认口径通过（曾经的必败 bug）', () => {
  const { cfg } = prepareScoreRequest([{ zgh: '100153', rdsj: '2019-07', level: '专业技术七级岗位' }], undef)
  return cfg.cutoffYeji === '2026-10-31' && cfg.cutoffGzl === '2026-06' && cfg.rzCutoff === '2026-10'
})

check('用户只说了"业绩认定截止 2026年11月"，模型把教学工作量截止也传成 2026-11 → 拒绝', () =>
  expectError(
    () =>
      prepareScoreRequest(
        [{ zgh: '100115', rdsj: '2023-09', level: '专技5级' }],
        {
          cutoffYeji: '2026-11-30',
          cutoffGzl: '2026-11',
          userSaid: '姜爽 100115 竞聘岗位 专技5级 起聘时间2023-09 业绩认定截止时间 2026年11月 重新测算一下原始分数细项和总和',
        }
      ),
    '没有提到教学工作量或学生管理的截止'
  )
)

check('用户明确说了工作量也算到 11 月 → 教学工作量截止允许传 2026-11', () => {
  const { cfg } = prepareScoreRequest(
    [{ zgh: '100115', rdsj: '2023-09', level: '专技5级' }],
    {
      cutoffYeji: '2026-11-30',
      cutoffGzl: '2026-11',
      userSaid: '姜爽 100115 专技5级 起聘2023-09，业绩和教学工作量都截止到 2026年11月 再算一遍',
    }
  )
  return cfg.cutoffYeji === '2026-11-30' && cfg.cutoffGzl === '2026-11'
})

check('模型单独传任职年限截止，用户没提任职年限 → 拒绝', () =>
  expectError(
    () =>
      prepareScoreRequest(
        [{ zgh: '100115', rdsj: '2023-09', level: '专技5级' }],
        { rzCutoff: '2026-11', userSaid: '姜爽 100115 专技5级 起聘2023-09 业绩认定截止时间 2026年11月' }
      ),
    '没有提到任职年限的截止'
  )
)

check('用户没说截止日期，模型自己传了 → 报错拒绝', () =>
  expectError(
    () => prepareScoreRequest([{ zgh: '100167', rdsj: '2016-07', level: '专技七级' }], { cutoffGzl: '2026-09', userSaid: '于洋 100167 竞聘辅系列专业技术七级岗位 起聘时间2016-07 算一下原始分' }),
    '在用户这句话里找不到'
  )
)

check('用户说了"2026年11月"，截止传 2026-11-30 → 通过，任职年限截止月随之为 2026-11', () => {
  const { cfg } = prepareScoreRequest(
    [{ zgh: '100115', rdsj: '2023-09', level: '专技5级' }],
    { cutoffYeji: '2026-11-30', userSaid: '姜爽 100115 竞聘岗位 专技5级 起聘时间2023-09 业绩认定截止时间 2026年11月 重新测算一下原始分数细项和总和' }
  )
  return cfg.cutoffYeji === '2026-11-30' && cfg.rzCutoff === '2026-11' && cfg.cutoffGzl === '2026-06'
})

check('用户写"26.10.31日"，截止传 2026-10-31 → 通过', () => {
  const { cfg } = prepareScoreRequest(
    [{ zgh: '100119', rdsj: '2023-09', level: '专技五级' }],
    { cutoffYeji: '2026-10-31', userSaid: '李斐斐100119拟聘岗位：专业技术五级岗位 起聘时间：2023-09。业绩认定截止时间：26.10.31日。' }
  )
  return cfg.cutoffYeji === '2026-10-31'
})

check('用户说的是 10 月，模型把工作量截止传成 2026-09 → 拒绝', () =>
  expectError(
    () =>
      prepareScoreRequest(
        [{ zgh: '100119', rdsj: '2023-09', level: '专技五级' }],
        { cutoffGzl: '2026-09', userSaid: '业绩认定截止时间：26.10.31日' }
      ),
    'cutoffGzl=2026-09'
  )
)

check('用户没说截止却传了（无原话）→ 拒绝', () =>
  expectError(() => prepareScoreRequest([{ zgh: '100119', rdsj: '2023-09', level: '专技五级' }], { cutoffYeji: '2026-11-30' }), '在用户这句话里找不到')
)

check('给管理辅助序列的人编一个"教学"序列 → 以名单为准并提示', () => {
  const { people } = prepareScoreRequest([{ zgh: '100115', rdsj: '2023-09', level: '专技5级', postSeq: '教学' }])
  const person = people[0]
  return person.postSeq === 'GF' && person.sources.postSeq === 'roster' && person.warnings.some((w) => w.includes('岗位序列') && w.includes('教学序列') && w.includes('管理和辅助序列'))
})

check('岗位序列用户没给 → 从名单回填，来源记为 roster', () => {
  const person = prepareScoreRequest([{ zgh: '100119', rdsj: '2023-09', level: '专技五级' }]).people[0]
  return person.postSeq === 'GF' && person.sources.postSeq === 'roster' && person.sources.series === 'roster' && person.warnings.length === 0
})

check('名单里没有的人缺什么一次列全，并要求向用户询问', () =>
  expectError(() => prepareScoreRequest([{ zgh: '100393', name: '杨清' }]), '起聘月')
)
check('…报错里同时含拟聘等级与岗位序列', () =>
  expectError(() => prepareScoreRequest([{ zgh: '100393', name: '杨清' }]), '拟聘等级') &&
  expectError(() => prepareScoreRequest([{ zgh: '100393', name: '杨清' }]), '岗位序列') &&
  expectError(() => prepareScoreRequest([{ zgh: '100393', name: '杨清' }]), '不要替用户假设')
)

check('起聘月与名单不同 → 按用户给的算并提示', () => {
  const person = prepareScoreRequest([{ zgh: '100115', rdsj: '2019-12', level: '专技五级' }]).people[0]
  return person.rdsj === '2019-12' && person.sources.rdsj === 'user' && person.warnings.some((w) => w.includes('起聘月') && w.includes('摸底名单里是「2023-09」'))
})

check('拟聘等级与名单不同档 → 按用户给的算并提示', () => {
  const person = prepareScoreRequest([{ zgh: '100119', rdsj: '2023-09', level: '专技十级' }]).people[0]
  return person.dj === 'zj' && person.warnings.some((w) => w.includes('拟聘等级'))
})

check('月份写法规范化：2023-9 / 2023年9月 / 2019-7', () => {
  const people = prepareScoreRequest([
    { zgh: '100119', rdsj: '2023-9', level: '专技五级' },
    { zgh: '100153', rdsj: '2019年7月', level: '专技七级' },
    { zgh: '100052', rdsj: '2019-7', level: '专技五级' },
  ]).people
  return people[0]?.rdsj === '2023-09' && people[1]?.rdsj === '2019-07' && people[2]?.rdsj === '2019-07'
})

check('等级写法：专业技术五级岗位 / 副高7级 / 专技十级 / 十一级 / 正高', () => {
  const people = prepareScoreRequest([
    { zgh: '100119', rdsj: '2023-09', level: '专业技术五级岗位' },
    { zgh: '100153', rdsj: '2019-07', level: '副高7级' },
    { zgh: '100104', rdsj: '2022-07', level: '专技十级' },
    { zgh: '100104', rdsj: '2022-07', level: '十一级' },
    { zgh: '100104', rdsj: '2022-07', level: '正高' },
  ]).people
  return [people[0]?.dj, people[1]?.dj, people[2]?.dj, people[3]?.dj, people[4]?.dj].join(',') === 'fgj,fgj,zj,cj,zgj'
})

check('等级写法认不出 → 报错', () => expectError(() => prepareScoreRequest([{ zgh: '100393', rdsj: '2023-09', level: '随便', postSeq: '教学' }]), '拟聘等级「随便」无法识别'))
check('工号带非法字符 → 报错', () => expectError(() => prepareScoreRequest([{ zgh: "100119'; drop table x" }]), '工号无法识别'))
check('空名单 → 报错', () => expectError(() => prepareScoreRequest([]), 'people 不能为空'))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
