# AGENTS.md

面向在本仓库工作的 AI 助手的说明。人读文档见 [README.zh-CN.md](README.zh-CN.md)。

## 项目概述

**职称评聘问答助手**（山东医药技师学院）：前端 fork 自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（v0.1.1）纯静态聊天应用，新增 `server/` BFF 服务端承载模型凭据、助手人设、技能包与 datacenter MCP 连接；老师打开页面直接问，无需任何配置。方案与决策记录见 [docs/职称评审助手服务端方案.md](docs/职称评审助手服务端方案.md)。

## 常用命令

| 命令                                          | 用途                                        |
| --------------------------------------------- | ------------------------------------------- |
| `npm run dev`                                 | 前端开发服务器（http://localhost:8090）     |
| `npm run build`                               | 生产构建到 `dist/`（`NODE_ENV=production`） |
| `npm run type` / `npm run lint` / `npm run format` | 前端类型检查 / oxlint / oxfmt          |
| `npm --prefix server run dev`                 | BFF 服务端（http://localhost:8787，含 MCP 自检） |
| `npm --prefix server run typecheck`           | 服务端类型检查                              |
| `npm --prefix server run regress`             | 原始分测算回归：重算摸底名单全员，与摸底表逐格对比（约 1 分钟，走现场库） |
| `npm --prefix server run test:guards`         | 算分入参防线的快速测试（不查库，秒级） |
| `npm --prefix server run e2e`                 | 端到端回放：用老师们的自然问法问助手，核对是否调工具、有无编入参、数字是否照抄引擎（需 BFF 已启动，约 10 分钟） |

- Node.js 22.12+。上游用 pnpm（`pnpm-lock.yaml` 为上游遗留），本地实际用 npm（`package-lock.json`），二者取一即可。
- **修改 `rspack.config.ts` 后必须重启 dev server**（配置不热更新）；src/ 改动会热更新，刷新页面即可。
- **完整运行需要两个进程**：先 `server`（BFF，8787），再前端 dev（8090，代理 `/anthropic /models /v1 /config` → 8787）；生产模式由 BFF 直接托管 `dist/`，单进程。
- `server/.env`（模型/MCP 凭据）与 `server/chatlogs/`（聊天记录，含个人信息）**不入库**。

## 服务端（server/）

```text
server/
  persona.md            助手人设 + 欢迎语（frontmatter greeting，经 GET /config 下发前端）
  knowledge/            跨会话背景记忆（*.md 全文注入 system prompt，放文件即生效）
  skills/zcps-score-audit/  职称评聘分数排查技能包（SKILL.md + references + scripts）
      scoring/          测算 SQL 模板与本轮参数（sql-templates.json、round-config.json）：
                        服务端算分引擎与 scripts/*.py 共用，改口径只改这里
      tests/            回归用例（姜爽、李斐斐两题的期望行为与历史记录）
  scripts/regress-scoring.ts  原始分测算回归脚本
  src/
    index.ts            Express 路由：POST /v1/messages（Agent 循环）、GET /models、
                        GET /config、本地附件接口、托管 dist/
    agent.ts            Agent 循环：人设注入、tool_use 服务端执行、tool_result 回传、
                        跨轮 SSE 索引连续化重写（前端仍是单消息语义）、
                        最后一轮无工具强制作答、max_tokens 上限、中间轮不回传 thinking、
                        伪调用标记（DSML）跨分片过滤与纠偏重试、说明文字闸门（工具轮的说明文字不外发）
    scoring.ts          原始分测算引擎：入参规范化（月份补零/等级/系列/岗位序列）与防线、内联名单、
                        执行 7 条模板 SQL、按 merge_final.py 规则合并、封顶口径
    mcp.ts              datacenter MCP 客户端：两步中继（query_site_platform_tool →
                        轮询 get_site_tool_operation），Streamable HTTP 优先、SSE 回退，
                        大结果分页拼接
    tools.ts            暴露给模型的 5 个工具：calc_raw_score（算分）/ get_score_detail（取原始
                        申报记录）/ read_skill_file / query_zcps_sql / get_table_schema；
                        SQL 只读校验（单条 SELECT/WITH）
    skills.ts           技能扫描、frontmatter 解析、read_skill_file（路径白名单+64KB 截断）、
                        knowledge 目录加载
    chatlog.ts          聊天记录按天存 server/chatlogs/*.md
    config.ts / upstream.ts / adapters/  .env 加载校验 / 上游协议分发 / 各协议适配器
```

**算分引擎（分数的唯一来源）**：`calc_raw_score` 用与摸底测算完全相同的算法算分。SQL 在 `skills/zcps-score-audit/scoring/sql-templates.json`，本轮参数（截止日期、各类上限）在同目录 `round-config.json`，都是运行时读取，改文件即生效、无需重启。模型不自己算分，只收集入参和解释（见 SKILL.md 0.2 节）。用户没给的入参从 `round-config.json` 里 `rosterCsv` 指向的摸底名单回填。**不要在别处复制这些 SQL**：`scripts/build_queries.py` 等读同一份模板，服务端与 Python 生成的 SQL 逐字节一致。改了模板、参数或 `scoring.ts` 之后跑 `npm --prefix server run regress`；当前基线是 83 人中 78 人与摸底表逐格一致，其余 5 人的差异原因记在 `tests/回归-李斐斐主档缺失.md`。

**模型给的入参不可信，防线做在服务端**（都由 `test:guards` 覆盖，改动后必跑）：
- 岗位序列、系列以摸底名单为准（名单上的事实）：模型曾给管理辅助序列的人编了"教学"序列，岗位业绩凭空多出十几分。
- 覆盖截止日期必须对得上**用户当前这句原话**：agent.ts 把原话经 `executeTool` 的 context 传给引擎（模型无法伪造），对不上直接报错。不用前面几轮的 user 消息，因为里面混有前端注入的系统提醒（含当天日期）。业绩截止、教学工作量截止、任职年限截止是三个独立口径：年月对得上之外，`cutoffGzl` / `rzCutoff` 还要求原话里提到对应事项（只看年月时，模型曾把用户说的"业绩截止 11 月"顺手也套到教学工作量截止上）。
- 只采纳有值的覆盖项：调用方传 `undefined` 不能把默认参数冲掉（这个 bug 曾让工具首调必败，模型反复重试后自行编参数）。
- 缺的入参一次列全并要求向用户询问，不许模型替用户假设。

**说明文字闸门**（agent.ts）：模型常在调工具前先说一句"我先查一下"（常是英文），靠人设规则约束不可靠。每轮文本先暂扣 2 秒：期间出现工具调用就整轮丢弃文本，没出现就放行并转为实时转发。内部历史始终记原文（伪调用检测依赖它），回传历史时截掉标记。闸门的副作用是测算等待的几十秒里页面会空白，所以 agent.ts 在第一个工具调用前由服务端发一行说明（`TOOL_STATUS_TEXT`，每条消息一次；措辞在回答出来后仍成立）。

**关键纪律放在工具结果里，不能只放技能文件**：模型不一定每次都去读 SKILL.md。`calc_raw_score` 的返回里带"回答要求""口径声明"（现成的一行，让模型照抄）、"摸底表对比"，分数是两位小数的文本。改这些文案后跑 `e2e`。

**记忆与数据装载约定**：`server/knowledge/*.md` 每轮对话自动全文注入（摸底交接摘要、口径决策等业务背景）；逐人明细等大文件放 `skills/zcps-score-audit/references/`（如 摸底测算_原始分_20261117.csv，83 人 × 44 列），模型按需 read_skill_file 读取。新增记忆/数据 = 放文件，无需改代码。

**模型服务多协议**：`.env` 里 `MODEL_PROTOCOL`（anthropic | openai-chat | openai-responses）+ `MODEL_ENDPOINT`（完整端点 URL）+ `MODEL_API_KEY` + `MODEL_ID`，厂商无关。Agent 循环内部统一 Anthropic 事件形态，协议转换在 `src/upstream.ts`（分发）与 `src/adapters/`（openai-chat 已实测含工具调用；openai-responses 按公开规范实现、无实测环境）。改 .env 需重启 BFF。

- 前端"API Key"为占位符 `intranet`（仅过本地检查），真实 key 在 `server/.env`；`GET /models` 恒 200。
- 技能包 `scripts/*.py`（年度整批摸底）是离线人工流程，BFF 不执行；它们与 BFF 共用 `scoring/` 下的模板与参数。
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

- **当前默认上游是内网网关**（`MODEL_PROTOCOL=openai-chat`）：它的 anthropic 入口不可用；`thinking:{type:'disabled'}` 能关闭思考（前端默认关；开着时单次思考可达十万字、十分钟跑不完）。该模型偶发把工具调用写成正文里的标记（DSML），agent.ts 有跨分片过滤和纠偏重试。
- **中继对大结果分页**：现场结果序列化后超过 12000 字符时，`get_site_tool_operation` 返回 `resultPage` 而不是 `result`，要按 `nextArguments` 续取再拼接（mcp.ts 已处理）；漏处理的表现是"成功但 0 行"。单次查询最多回 100 行。
- **现场不返回 ORA 错误码**：SQL 写错一律包装成"执行失败，请检查参数、权限或服务日志"，所以列名必须来自已验证的模板。Oracle 11g 用 ROWNUM 分页；单个字符串字面量上限 4000 字节，SQL 文本本身 9K 字符实测可用。
- **计分视图依赖岗位主档**：53 个 `V_RSC_*` 视图都从 `V_RSC_GWJP_JSXX`（一个固定批次的申报名册）出发，不在主档里的人视图口径恒为 0——算分引擎不用视图，不受影响。
- GLM 官方端点（以下为历史记录，切换上游时参考）：
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

服务端改动另跑 `npm --prefix server run typecheck` 与 `npm --prefix server run test:guards`；涉及算分、取数或技能说明的改动再跑 `npm --prefix server run regress`，并用 `tests/` 里的回归题回放对照。只测引擎和回归脚本发现不了"模型怎么调用工具"的问题——工具入口的参数处理、模型编造入参这类问题只有端到端回放才暴露，所以改完一定要按 `tests/端到端用例.md` 走一遍助手。

# 分叉前先对齐（Discuss Before Diverging）

- **思维链与前置侦察硬熔断**：当需求在产品意图、改动边界或架构方案上存在 ≥ 2 种合理解释时：
    1. **禁止在 `<thought>` 中推演未确认分支**：每个候选方向仅用 1 句话概括分叉点与核心取舍，严禁在思维链里提前设计各分支的实现细节、极端边界或顺手重构方案。
    2. **对齐前只读侦察最多 1 轮**：提问前最多执行 ≤ 3 次直接读文件，或 1 批并发只读子代理（`research` / `Explore`）核对代码现状。（注：需求明确时的并发全量侦察不受此限。）
    3. **零顺手扩写**：严禁脑补未提及的未来扩展需求，严禁捆绑“顺便清理周边代码”的改动。
- **单轮合并确认（优先级高于 `superpowers:brainstorming` 的多轮单问/禁菜单规则）**：除非用户明确要求开放式头脑风暴或交互式设计访谈（如 `/grill-me`），否则先用 2～3 句话同步已知代码事实，并在**同一轮**完成对齐（如需建议模型档位或执行模式，一并合并）：
    - **有限方案选择（架构取舍、范围边界、执行模式）**：主动调用结构化提问工具（`ask_question` / `AskUserQuestion` / `AskQuestion`）提供 2～4 个具体选项，并将推荐项标为 `(Recommended)` 置顶。
    - **开放式目标澄清（尚不清楚用户核心诉求）**：仅用 1 句简明纯文本提问，不预设引导性选项。