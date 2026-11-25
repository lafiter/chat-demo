import path from 'node:path'
import express from 'express'
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

  // 附件走 BFF 本地 Files API；语音（/v1/tools）此前透传上游已无对应端点，路由移除
  app.post('/anthropic/v1/files', upload.single('file'), uploadFileHandler)
  app.delete('/anthropic/v1/files/:id', deleteFileHandler)

  app.use(express.json({ limit: '4mb' }))
  // 前端按 Anthropic 路径约定请求 /anthropic/v1/messages；裸 /v1/messages 一并支持
  app.post(['/v1/messages', '/anthropic/v1/messages'], handleMessages)
  app.get('/models', (_req, res) => {
    res.json({
      object: 'list',
      data: [
        {
          id: config.modelId,
          display_name: config.modelId,
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
