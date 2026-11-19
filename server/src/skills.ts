import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { config, serverRoot } from './config.js'

export type SkillInfo = {
  /** frontmatter 的 name */
  name: string
  description: string
  /** 技能目录（绝对路径） */
  dir: string
  /** 目录内全部文件的相对路径（含 SKILL.md） */
  files: string[]
}

/** 单文件读取上限，超出截断，避免超长参考文件撑爆上下文 */
const FILE_LIMIT = 64 * 1024

const listFiles = (dir: string, base = ''): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const rel = base ? `${base}/${entry}` : entry
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, rel))
    } else {
      out.push(rel)
    }
  }
  return out
}

const parseFrontmatter = (text: string): Record<string, string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fields: Record<string, string> = {}
  if (!match) {
    return fields
  }
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) {
      fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
    }
  }
  return fields
}

/** 扫描 skills 下各技能目录的 SKILL.md；frontmatter 缺 name 时取目录名 */
export const loadSkills = (): SkillInfo[] => {
  let entries: string[]
  try {
    entries = readdirSync(config.skillsRoot)
  } catch {
    return []
  }
  const skills: SkillInfo[] = []
  for (const entry of entries) {
    const dir = path.join(config.skillsRoot, entry)
    const skillMd = path.join(dir, 'SKILL.md')
    try {
      const fields = parseFrontmatter(readFileSync(skillMd, 'utf8'))
      skills.push({
        name: fields.name || entry,
        description: fields.description ?? '',
        dir,
        files: listFiles(dir),
      })
    } catch {
      // 无 SKILL.md 的目录跳过
    }
  }
  return skills
}

export const skills = loadSkills()

/** 注入 system prompt 的技能清单：只列名称/描述/文件，内容按需用 read_skill_file 读取 */
export const buildSkillCatalog = (): string => {
  if (skills.length === 0) {
    return ''
  }
  const lines = skills.map(
    (skill) =>
      `### ${skill.name}\n${skill.description}\n文件：${skill.files.map((f) => `\`${skill.name}/${f}\``).join('、')}`
  )
  return [
    '## 可用技能',
    '以下技能包描述了排查流程与计分口径。回答涉及具体规则、SQL 模板、办法条款时，先用 read_skill_file 读取对应文件再作答，不要凭记忆编造。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * 读取技能目录内的文件。relPath 相对 skills/ 根（如 `zcps-score-audit/SKILL.md`）；
 * 路径解析后必须仍在技能根内（防目录穿越），超长截断。
 */
export const readSkillFile = (relPath: string): string => {
  const root = path.resolve(config.skillsRoot)
  const full = path.resolve(root, relPath)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${relPath}`)
  }
  const text = readFileSync(full, 'utf8')
  if (text.length > FILE_LIMIT) {
    return `${text.slice(0, FILE_LIMIT)}\n\n（文件超长，已截断）`
  }
  return text
}

/**
 * 跨会话背景记忆：server/knowledge/ 下的 markdown 全文注入 system prompt，
 * 每轮对话自动加载（摸底交接摘要、口径决策等业务背景）。新增记忆直接放文件即可。
 */
export const loadKnowledge = (): string => {
  const dir = path.join(serverRoot, 'knowledge')
  let files: string[]
  try {
    files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.md'))
  } catch {
    return ''
  }
  const sections = files
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), 'utf8').replace(/^\ufeff/, '').trim()
      return text ? `### ${file}\n\n${text}` : ''
    })
    .filter(Boolean)
  if (sections.length === 0) {
    return ''
  }
  return [
    '## 背景记忆（自动加载，回答时结合使用）',
    ...sections,
  ].join('\n\n')
}

export const serverInfo = { serverRoot }
