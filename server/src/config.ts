import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = path.dirname(fileURLToPath(import.meta.url))
export const serverRoot = path.resolve(srcRoot, '..')

/** 极简 .env 加载：已存在的环境变量不覆盖；文件不存在时静默跳过 */
const loadEnvFile = () => {
  try {
    const text = readFileSync(path.join(serverRoot, '.env'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) {
        continue
      }
      const eq = trimmed.indexOf('=')
      if (eq <= 0) {
        continue
      }
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      process.env[key] ??= value
    }
  } catch {
    // 无 .env 时直接用进程环境变量
  }
}
loadEnvFile()

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback

/** persona.md：frontmatter 取欢迎语主/副标题，正文为人设 */
const loadPersona = (): { greeting: string; subtitle: string; body: string } => {
  const text = readFileSync(path.join(serverRoot, 'persona.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) {
    return { greeting: '', subtitle: '', body: text }
  }
  const field = (key: string): string => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1])?.[1]?.trim() ?? ''
  return { greeting: field('greeting'), subtitle: field('subtitle'), body: match[2].trim() }
}

const persona = loadPersona()

export const config = {
  port: Number(env('PORT', '8787')),
  glmApiKey: env('GLM_API_KEY'),
  glmModel: env('GLM_MODEL', 'glm-5.3'),
  /** 上游根地址；Anthropic 兼容端点为 `${upstreamRoot}/anthropic/v1` */
  upstreamRoot: env('GLM_UPSTREAM_ROOT', 'https://open.bigmodel.cn/api').replace(/\/+$/, ''),
  mcpUrl: env('MCP_URL'),
  mcpToken: env('MCP_TOKEN'),
  mcpToolTimeoutMs: Number(env('MCP_TOOL_TIMEOUT_SEC', '600')) * 1000,
  siteId: env('SITE_ID'),
  dataSourceId: env('DATA_SOURCE_ID'),
  skillsRoot: path.join(serverRoot, 'skills'),
  chatlogDir: path.join(serverRoot, 'chatlogs'),
  greeting: persona.greeting,
  subtitle: persona.subtitle,
  personaBody: persona.body,
}

/** 启动前校验必填项，缺了直接退出，避免带病运行 */
export const assertConfig = (): void => {
  const missing = (
    [
      ['GLM_API_KEY', config.glmApiKey],
      ['MCP_URL', config.mcpUrl],
      ['MCP_TOKEN', config.mcpToken],
      ['SITE_ID', config.siteId],
      ['DATA_SOURCE_ID', config.dataSourceId],
    ] as const
  ).filter(([, value]) => !value)
  if (missing.length > 0) {
    console.error(`[config] 缺少必填配置：${missing.map(([key]) => key).join('、')}，请检查 server/.env`)
    process.exit(1)
  }
}
