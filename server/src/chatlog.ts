import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

/**
 * 聊天记录：按天存 markdown（server/chatlogs/YYYY-MM-DD.md）。
 * 每轮记录提问、工具调用与最终回答，供管理员查阅；无用户身份，以时间与内容为准。
 */

const pad = (value: number): string => String(value).padStart(2, '0')

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|')

export const appendChatLog = (
  question: string,
  toolCalls: string[],
  answer: string,
  meta: { model: string; rounds: number; error?: string }
): void => {
  try {
    mkdirSync(config.chatlogDir, { recursive: true })
    const now = new Date()
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    const file = path.join(config.chatlogDir, `${date}.md`)
    let isNew = false
    try {
      readFileSync(file, 'utf8')
    } catch {
      isNew = true
    }
    if (isNew) {
      writeFileSync(file, `# 聊天记录 ${date}\n\n`)
    }
    const sections = [
      `## ${time}`,
      '',
      `**问**：${question || '（空）'}`,
      '',
      toolCalls.length > 0
        ? `**工具调用**（${meta.rounds} 轮）：\n${toolCalls.map((call) => `- ${escapeCell(call)}`).join('\n')}`
        : `**工具调用**：无（${meta.rounds} 轮）`,
      '',
      `**答**：${meta.error ? `（失败：${meta.error}）` : answer || '（空）'}`,
      '',
      '---',
      '',
    ]
    appendFileSync(file, sections.join('\n'))
  } catch (error) {
    // 日志失败不影响会话本身
    console.error('[chatlog] 写入失败：', error instanceof Error ? error.message : error)
  }
}
