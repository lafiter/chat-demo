# 批量测算脚本使用说明

## 流程（三步）

### ① 生成 7 个批量 SQL

```bash
python scripts/build_queries.py <当轮名单.xlsx> <工作目录>
# 产出 工作目录/b1.sql ~ b7.sql；轮次参数（截止日期等）改 build_queries.py 顶部 CONFIG
```

- b1 学历 ｜ b2 工作质量 ｜ b3 本职工作量+党政 ｜ b4 学生管理（含培训 khdc空=系数1）
- b5 论文/教材/专利/成果奖/教材奖 ｜ b6 纵向/横向/成果转化 ｜ b7 岗位业绩（zynl 已内置 QZ>1 ÷100 换算）

### ② 经职称评审 MCP 中继执行（会话内做，脚本无法直连）

对每个 b*.sql：`query_site_platform_tool` 包 `preview_table_data`（siteId 与数据源 ID 见 SKILL.md 第 2 节，
customSql=SQL 文件内容, limit=100, idempotencyKey 每次唯一）→ 轮询 `get_site_tool_operation` 取
`result.data.rows`（注意大结果分页，按 nextOffset 续取后拼接）→ 存为 `工作目录/b*.json`（rows 数组原样落盘）。

### ③ 合并出 v9 版式 Excel

```bash
python scripts/merge_final.py <当轮名单.xlsx> <工作目录> <输出.xlsx>
# 任职年限截止月与 build_queries.py CONFIG 同步修改（RZ_CUTOFF）
```

输出：三级分类表头 + 44 列明细 + 总分前置 + 主系列→竞聘等级→总分倒序 + 两位小数，附口径说明 sheet。
脚本自带合计校验（异常名单打印在 stdout）。

## 年度维护（每年评审季更新一次）

1. `build_queries.py` 顶部 CONFIG：业绩/工作量截止、出勤年度、教学工作量 form_code；
2. `merge_final.py` 的 RZ_CUTOFF；
3. SKILL.md 固定口径表中的默认 0 项名单、重名清单（人员会变）；
4. 名单 Excel 用当轮新文件；重跑一遍 ①②③。
