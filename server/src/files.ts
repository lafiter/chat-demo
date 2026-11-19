import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Request, Response } from 'express'
import { serverRoot } from './config.js'

/**
 * 本地 Files API：GLM 的 Anthropic 端点没有 /anthropic/v1/files（实测 404），
 * BFF 自行收存附件，发消息时把 file 块转成 GLM 支持的形态：
 * - 图片 → base64 内联 image 块
 * - 文本类（txt/md/csv/代码等）→ 文字注入 text 块
 * - PDF 等暂不支持的格式 → 上传时明确拒绝
 */

const uploadsDir = path.join(serverRoot, 'uploads')

/** 文本注入的单文件截断上限，与 read_skill_file 一致 */
const TEXT_LIMIT = 64 * 1024

/** 允许按文本注入的扩展名（前端 ACCEPT_FILE_EXTS 的非图片部分，去掉 PDF） */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'tsv', 'html', 'htm', 'json', 'xml', 'log',
  'wxml', 'wxss', 'wxs', 'axml', 'acss', 'sjs', 'swan', 'ttml', 'ttss', 'qml', 'qss',
  'js', 'ts', 'tsx', 'jsx', 'css', 'java', 'py', 'sql', 'yml', 'yaml', 'svg',
])

const extensionOf = (filename: string): string => filename.toLowerCase().split('.').pop() ?? ''

export type StoredFile = {
  id: string
  filename: string
  media_type: string
  size_bytes: number
  created_at: string
}

const metaPath = (id: string): string => path.join(uploadsDir, `${id}.json`)
const dataPath = (id: string): string => path.join(uploadsDir, `${id}.bin`)

export type UploadDecision = { ok: true } | { ok: false; message: string }

/** 上传前的支持性校验，给前端可读的拒绝原因 */
export const checkUploadSupport = (filename: string, mediaType: string): UploadDecision => {
  const ext = extensionOf(filename)
  if (mediaType.startsWith('image/') && ext !== 'svg') {
    return { ok: true }
  }
  if (TEXT_EXTENSIONS.has(ext) || mediaType.startsWith('text/')) {
    return { ok: true }
  }
  if (ext === 'pdf') {
    return { ok: false, message: '当前模型暂不支持 PDF 附件，请转为图片或纯文本后上传' }
  }
  return { ok: false, message: `暂不支持 ${ext || '该类型'} 附件，支持图片与常见文本文件` }
}

/** 存储上传文件（multer 已解析），返回前端期望的 FileObject 形状 */
export const saveUpload = (file: {
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}): StoredFile => {
  mkdirSync(uploadsDir, { recursive: true })
  const stored: StoredFile = {
    id: `file-${randomUUID()}`,
    filename: file.originalname,
    media_type: file.mimetype,
    size_bytes: file.size,
    created_at: new Date().toISOString(),
  }
  writeFileSync(dataPath(stored.id), new Uint8Array(file.buffer))
  writeFileSync(metaPath(stored.id), JSON.stringify(stored), 'utf8')
  return stored
}

export const readFileMeta = (id: string): StoredFile | null => {
  try {
    return JSON.parse(readFileSync(metaPath(id), 'utf8')) as StoredFile
  } catch {
    return null
  }
}

export const readFileBuffer = (id: string): Buffer | null => {
  try {
    return readFileSync(dataPath(id))
  } catch {
    return null
  }
}

export const removeUpload = (id: string): boolean => {
  if (!existsSync(metaPath(id))) {
    return false
  }
  rmSync(metaPath(id), { force: true })
  rmSync(dataPath(id), { force: true })
  return true
}

/** POST /anthropic/v1/files 的处理器（经 multer single('file') 解析） */
export const uploadFileHandler = (req: Request, res: Response): void => {
  const file = req.file
  if (!file) {
    res.status(400).json({ error: { message: '缺少 file 字段' } })
    return
  }
  const decision = checkUploadSupport(file.originalname, file.mimetype)
  if (!decision.ok) {
    res.status(415).json({ error: { message: decision.message } })
    return
  }
  const stored = saveUpload(file)
  res.json({ ...stored, type: 'file' })
}

/** DELETE /anthropic/v1/files/:id */
export const deleteFileHandler = (req: Request, res: Response): void => {
  const removed = removeUpload(req.params.id)
  res.status(removed ? 200 : 404).json({ id: req.params.id, deleted: removed })
}

type ContentBlock = Record<string, unknown> & { type: string }

const isFileBlock = (
  block: ContentBlock
): block is ContentBlock & { source: { type: 'file'; file_id: string } } => {
  if (block.type !== 'image' && block.type !== 'document') {
    return false
  }
  const source = (block as { source?: unknown }).source
  return (
    typeof source === 'object' &&
    source !== null &&
    (source as { type?: unknown }).type === 'file' &&
    typeof (source as { file_id?: unknown }).file_id === 'string'
  )
}

/**
 * 把消息里的 file 块转成 GLM 支持的形态：
 * 图片 → base64 内联；文本附件 → 文字注入；失效 → 说明性文本块。
 */
export const fileBlockToInline = (block: ContentBlock): ContentBlock => {
  if (!isFileBlock(block)) {
    return block
  }
  const fileId = block.source.file_id
  const meta = readFileMeta(fileId)
  const buffer = meta ? readFileBuffer(fileId) : null
  if (!meta || !buffer) {
    return { type: 'text', text: `【附件已失效（${fileId}）】` }
  }
  const ext = extensionOf(meta.filename)
  if (meta.media_type.startsWith('image/') && ext !== 'svg') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: meta.media_type, data: buffer.toString('base64') },
    }
  }
  let text = buffer.toString('utf8')
  if (text.length > TEXT_LIMIT) {
    text = `${text.slice(0, TEXT_LIMIT)}\n（附件超长，已截断）`
  }
  return { type: 'text', text: `【附件 ${meta.filename}】\n${text}` }
}
