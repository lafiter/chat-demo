import path from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import { handleMessages } from './agent.js'
import { assertConfig, config, serverRoot } from './config.js'
import { deleteFileHandler, uploadFileHandler } from './files.js'
import { connectMcp, selfCheck } from './mcp.js'

/**
 * 职称评聘问答助手 BFF：
 * - POST /v1/messages    Agent 循环（人设+技能+MCP 工具），Anthropic 兼容 SSE
 * - GET  /models         Key 校验占位（恒 200）
 * - GET  /config         助手配置（欢迎语）下发
 * - /anthropic/v1/files、/v1/tools/*  附件与语音透传（换真实 key）
 * - 静态托管 ../dist（生产模式同源部署）
 */

/** 透传到 GLM 上游：注入真实 key，请求体原样转发 */
const proxyUpstream = async (req: Request, res: Response): Promise<void> => {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.glmApiKey}`,
      'x-api-key': config.glmApiKey,
    }
    if (typeof req.headers['content-type'] === 'string') {
      headers['Content-Type'] = req.headers['content-type']
    }
    const raw = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : undefined
    const body = raw && raw.length > 0 ? raw : undefined
    const response = await fetch(`${config.upstreamRoot}${req.path}`, {
      method: req.method,
      headers,
      body,
    })
    res.status(response.status)
    const contentType = response.headers.get('content-type')
    if (contentType) {
      res.setHeader('Content-Type', contentType)
    }
    res.send(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(502).json({ error: { type: 'api_error', message: `上游请求失败：${message}` } })
  }
}

const main = async (): Promise<void> => {
  assertConfig()
  try {
    await connectMcp()
    await selfCheck()
    console.log('[mcp] datacenter MCP 连接与自检通过')
  } catch (error) {
    console.error('[mcp] 自检失败，拒绝启动：', error instanceof Error ? error.message : error)
    process.exit(1)
  }

  const app = express()
  const upload = multer({ limits: { fileSize: 32 * 1024 * 1024 } })

  // 附件走 BFF 本地 Files API（GLM 端点无此接口），语音仍透传
  app.post('/anthropic/v1/files', upload.single('file'), uploadFileHandler)
  app.delete('/anthropic/v1/files/:id', deleteFileHandler)
  app.post('/v1/tools/:tool', express.raw({ type: () => true, limit: '64mb' }), proxyUpstream)

  app.use(express.json({ limit: '4mb' }))
  // 前端按 Anthropic 路径约定请求 /anthropic/v1/messages；裸 /v1/messages 一并支持
  app.post(['/v1/messages', '/anthropic/v1/messages'], handleMessages)
  app.get('/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [
        {
          id: config.glmModel,
          display_name: config.glmModel,
          type: 'model',
          created_at: new Date().toISOString(),
        },
      ],
    })
  })
  app.get('/config', (_req, res) => {
    res.json({ greeting: config.greeting, subtitle: config.subtitle })
  })

  // 生产模式托管前端静态产物（与 API 同源，规避跨域）
  app.use(express.static(path.resolve(serverRoot, '..', 'dist')))

  app.listen(config.port, () => {
    console.log(`[server] 职称评聘问答助手 BFF 已启动：http://localhost:${config.port}`)
  })
}

main().catch((error) => {
  console.error('[server] 启动失败：', error)
  process.exit(1)
})
