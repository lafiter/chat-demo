# AGENTS.md

面向在本仓库工作的 AI 助手的说明。人读文档见 [README.zh-CN.md](README.zh-CN.md)。

## 项目概述

**职称评聘问答助手**（山东医药技师学院）：前端 fork 自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（v0.1.1）纯静态聊天应用，新增 `server/` BFF 服务端承载 GLM key、助手人设、技能包与 datacenter MCP 连接；老师打开页面直接问，无需任何配置。方案与决策记录见 [docs/职称评审助手服务端方案.md](docs/职称评审助手服务端方案.md)。

## 常用命令

| 命令                                          | 用途                                        |
| --------------------------------------------- | ------------------------------------------- |
| `npm run dev`                                 | 前端开发服务器（http://localhost:8090）     |
| `npm run build`                               | 生产构建到 `dist/`（`NODE_ENV=production`） |
| `npm run type` / `npm run lint` / `npm run format` | 前端类型检查 / oxlint / oxfmt          |
| `npm --prefix server run dev`                 | BFF 服务端（http://localhost:8787，含 MCP 自检） |
| `npm --prefix server run typecheck`           | 服务端类型检查                              |

- Node.js 22.12+。上游用 pnpm（`pnpm-lock.yaml` 为上游遗留），本地实际用 npm（`package-lock.json`），二者取一即可。
- **修改 `rspack.config.ts` 后必须重启 dev server**（配置不热更新）；src/ 改动会热更新，刷新页面即可。
- **完整运行需要两个进程**：先 `server`（BFF，8787），再前端 dev（8090，代理 `/anthropic /models /v1 /config` → 8787）；生产模式由 BFF 直接托管 `dist/`，单进程。
- `server/.env`（GLM/MCP 凭据）与 `server/chatlogs/`（聊天记录，含个人信息）**不入库**。

## 服务端（server/）

```text
server/
  persona.md            助手人设 + 欢迎语（frontmatter greeting，经 GET /config 下发前端）
  knowledge/            跨会话背景记忆（*.md 全文注入 system prompt，放文件即生效）
  skills/zcps-score-audit/  职称评聘分数排查技能包（SKILL.md + references + scripts）
  src/
    index.ts            Express 路由：POST /v1/messages（Agent 循环）、GET /models、
                        GET /config、附件与语音透传、托管 dist/
    agent.ts            Agent 循环：人设注入、tool_use 服务端执行、tool_result 回传、
                        跨轮 SSE 索引连续化重写（前端仍是单消息语义）、
                        最后一轮无工具强制作答、max_tokens 上限、中间轮不回传 thinking
    mcp.ts              datacenter MCP 客户端：两步中继（query_site_platform_tool →
                        轮询 get_site_tool_operation），Streamable HTTP 优先、SSE 回退
    tools.ts            暴露给模型的 3 个只读工具：read_skill_file / query_zcps_sql /
                        get_table_schema；SQL 只读校验（单条 SELECT/WITH）
    skills.ts           技能扫描、frontmatter 解析、read_skill_file（路径白名单+64KB 截断）、
                        knowledge 目录加载
    chatlog.ts          聊天记录按天存 server/chatlogs/*.md
    config.ts / upstream.ts  .env 加载校验 / GLM SSE 客户端
```

**记忆与数据装载约定**：`server/knowledge/*.md` 每轮对话自动全文注入（摸底交接摘要、口径决策等业务背景）；逐人明细等大文件放 `skills/zcps-score-audit/references/`（如 摸底测算_原始分_20261117.csv，83 人 × 44 列），模型按需 read_skill_file 读取。新增记忆/数据 = 放文件，无需改代码。

- 前端"API Key"为占位符 `intranet`（仅过本地检查），真实 key 在 `server/.env`；`GET /models` 恒 200。
- 技能包 `scripts/` 的整批测算是离线人工流程，BFF 不执行技能内脚本。
- SKILL.md 是排查口径的权威来源（固定口径、重名核对、红线），改口径优先改技能包而非代码。

## 架构

```text
rspack.config.ts        createConfig({ apiOrigin, apiKey, model, devServer })
                        DefinePlugin 注入 __API_ORIGIN__ / __API_KEY__ / __MODEL__
                        dev 模式注入空 origin，devServer 代理 /anthropic /models /v1 → apiOrigin
src/
  app/                  布局、主题、全局样式
  components/           聊天、设置、Markdown 等界面组件（CSS Modules）
  i18n/                 中英文文案（translate()）
  services/
    api/client.ts       Anthropic 兼容客户端：POST /anthropic/v1/messages SSE 流式、
                        Files API 上传删除、GET /models 校验 Key
    api/types.ts        协议类型，只取应用用到的字段；ChatModel 是封闭联合类型
    api/parseEvent.ts   SSE 事件解析；未知事件静默丢弃，勿依赖报错暴露问题
    chat/store.ts       zustand 会话状态机；MODEL 常量与 system prompt 在此
    chat/reply.ts       toRequestMessages 历史回传；reminder 快照以 user 角色注入
    chat/history/       ZIP 导入导出，格式见其 README（export_format_version: 3）
    speech/             ASR/TTS（/v1/tools/asr|tts，Bearer 鉴权）
  utils/                通用工具
```

- 设置与 API Key 存 localStorage（`services/settings.ts`），会话与附件存 IndexedDB（idb）。
- `__API_ORIGIN__` 为空串时所有请求走同源（dev 代理或 BFF 托管）。

## 本地定制的关键事实（改代码前必读）

- **GLM 端点不做 CORS**：预检响应无 `Access-Control-Allow-Origin`，浏览器直连必失败。开发模式必须经 devServer 代理（`rspack.config.ts` 的 `API_PROXY_PATHS`）。
- GLM 端点对 DeepSeek 扩展字段**宽容但忽略**：`safety_check`、`deepseek_*` 工具、`title`、`thinking: {type:'disabled'}` 都不会报错也不会生效（glm-5.3 始终输出 thinking 块）。
- GLM 端点**完整支持**标准 Anthropic 客户端工具循环：`tools`（input_schema）→ `tool_use`（流式 `input_json_delta`）→ `tool_result` 续答。`latest_reminder` 角色不受支持，已改为普通 `user` 消息。
- 模型 ID 以 `GET {API_ORIGIN}/models` 返回为准（glm-4.5 ~ glm-5.3-flashx 系列）。
- 默认 Key 是构建期注入的（`__API_KEY__`），任何拿到页面的人可见，仅限本地 demo；正式部署必须移除（见方案文档）。

## 代码约定

- 注释一律**中文**，写"为什么"而非"是什么"；沿用现有命名与密度。
- import 路径带 `.js` 后缀（`./x.js`），rspack `extensionAlias` 解析到同名 `.ts/.tsx`。
- CSS Modules 用默认导出：`import styles from './x.module.css'`。
- 类型收窄用窄谓词函数（参考 `parseEvent.ts` 的 `isRecord`/`isString` 模式）。
- 协议类型只声明应用实际消费的字段，不整份照抄 API 文档。

## 已知坑

- Git Bash 下 `curl -d` 含中文会以本地编码发送，导致服务端报 "error parsing the body"——测试中文请求体请写入 UTF-8 临时文件后 `--data-binary @file`。
- `npm run build` 产物直连远端 API 时同样受 CORS 限制；`file://` 打开 `dist/index.html` 还需浏览器允许 file:// 页面存储。
- 分发 dist/ 时须保留 `dist/LICENSE`（构建自动复制）。

## 验证

改动后依次：`npm run type`、`npm run lint`；涉及请求链路的改动在浏览器（http://localhost:8090）实测流式会话，多轮上下文追问验证历史回传。
