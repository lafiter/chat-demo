# 单项 ↔ 视图 ↔ 底层表 ↔ 算法对应表

计分视图与业绩表在山东医药技师学院**现场平台**，经职称评审 MCP（datacenter）中继查询（工具链见 SKILL.md 第 2 节，数据源「表单工作站」）；SQL 中对象名直接使用、不加 schema 前缀。
通用 join：业绩表 `t` × `ss_process p ON p.id=t.id`（取 FINISHAGREE）× 名单（提供 rdsj 起聘月、序列、竞聘等级）。
人员表（_RY 后缀为参与人子表，含 zgh/wc 位次/gxd 贡献度）。

## 一、基础分（上限15）

| 单项 | 视图 | 底层表 | 算法 |
|---|---|---|---|
| 任职年限 | V_RSC_RZNX | DA022_T_JSJBXX_G_5O1I + ZJB_RSC_PRDJ | 月数×0.1，按"竞聘等级↔聘任等级区间"累计；**库口径**截止取 annual_review_info(GWJP) 的 end_time（当前=2028-10），摸底用名单口径截止 2026-10 |
| 学历 | V_RSC_XL | DA022_T_JSJBXX（c_jxjyxl/c_yjsxl/c_bkxl 三级取最高） | 专科1/本科3/学士4/本科硕士5/硕士7/博士9 |

## 二、工作量分（上限25）

| 单项 | 视图 | 底层表 | 算法 |
|---|---|---|---|
| 本职·主系列 | V_RSC_BZGZ(上) / V_RSC_BZGZ_JXGZL | DA022_YJ_JXGZL（form_code='11981c45708c482ca98370e31ee99568'） | Σ教学工作量/160；学期起始月与聘任月的年内系数折算 |
| 本职·辅系列 | V_RSC_BZGZ(下) / V_RSC_BZGZ_MX | DA022_YJ_JSCQQK（sjts 事假天/bjts 病假天/qxhdcs 缺席次数） | max(10−⌊事假/5⌋×0.5−⌊病假/10⌋×0.5−缺席×0.1, 0) |
| 党政管理 | V_RSC_JZGZ(_MX) | DA022_T_JS_GZJL（zwjb 职务级别） | 月数/12 × 院领导3/中层正职2.4/中层副职1.8/科员等1.2 每年 |
| 班主任(现行) | V_RSC_XSGLGZ_JZBZR(_XNXQ) | DA022_YJ_FDYDB（sf 兼职/专职/兼职副班主任, xss 人数, bjlx 班级类型, rzys 任期月） | 40人0.5/学期+0.01/人(上限100人)；30-39→0.4；20-29→0.3；<20→0.1；副班主任按40%(基数16)；鲁甘×2；联培按40；任期系数 4月=1/2-4月=0.5/<2月=0；专职带班>2个按平均人数 |
| 班主任(历史) | V_RSC_JZBZFZGF(_MX) | DA022_YJ_BZRDB_LS（jbgzlf+gzzlf 已算好，按月一条） | 直接汇总；窗口月=学年首年+月份，**春季月份(三~六月)被前置一年**，起聘后首学年春季记录会被误排除 |
| 实习学生管理 | V_RSC_SXXSGL(_MX) | DA022_YJ_SXXSGL + _G_ORIG | 工学交替60人0.2+0.002/人；岗位实习120人0.2+0.001/人；×考核系数；原班主任按20% |
| 培训班主任 | V_RSC_PX(_XNXQ) | DA022_YJ_PX（wcpxrs/pxxss/khdc） | ≥40人0.125、30-39→0.1、20-29→0.05 每周期 × 学时系数(30学时=1) × 考核系数；**khdc 空=1** |
| 继续教育班主任 | V_RSC_JXJYXSGL(_XNXQ) | DA022_YJ_JXJYXSGL（rs/khdc） | ≥40人0.2、30-39→0.16、20-29→0.12 每学期 × 考核系数；**khdc 空=1** |
| 学工考核系数 | 内嵌上述 | — | 优1.2/良1.1/合格1.0/基本合格0.8/不合格0 |

## 三、工作质量分（上限10）

| 单项 | 视图 | 底层表 | 算法 |
|---|---|---|---|
| 表彰 | V_RSC_BZ | DA022_YJ_BZ + DA022_YJ_BZ_BY | 国16/省12/厅8/市局委4/校2；通报表扬减半；按(人,类别,年度)取最高再求和 |
| 奖励 | V_RSC_JL | DA022_YJ_JL（jldj） | 记大功/记功=6，嘉奖=2 |
| 考核优秀 | V_RSC_NDKH | DA022_YJ_NDKH + DA022_YJ_PQKH | 年度优秀2/次，聘期优秀4/次 |
| 支持发展 | V_RSC_ZCXYFZ（_MX_WPGZ/_ZS/_JXJY） | DA022_YJ_WPGZ / _ZSRW / _JXJYZS | 外派月×0.2；招生近3年平均超额×0.2 上限3（不足年份数按实际年均）；继教招生0.1/人 上限3 |

## 四、专业工作业绩分（上限30）

| 单项 | 视图 | 底层表 | 算法 |
|---|---|---|---|
| 论文 | V_RSC_LW(_MX) | DA022_YJ_KY_LW + _RY（jb/wc/fbsj） | A15(1/0.8/0.6/0.4前4位)、B12(1/0.8/0.5前3)、C4/D3(1/0.8/0.6前3)、E2(1/0.5前2)；C/D/E限2篇 |
| 教材著作 | V_RSC_KY_JCZZ(_MX) | DA022_YJ_KY_JCZZ + _RY（jcjb/cbjs/cbzs） | 分值表(国规划15/12/10/5…校本4/3/2/1)×min(字数/2万,1)；主审=第一主编减半；非规划限2部 |
| 纵向课题 | V_RSC_KT_ZXKT(_MX) | DA022_YJ_KT_ZXKT + _RY（jb/wc/ktjf/jfly/jtsj） | 码表(lx='纵向课题') + ⌊到账/万⌋×2(主持人、非自筹)；正高校级不计、副高校级限2项 |
| 横向课题 | V_RSC_KY_HXKT(_MX) | DA022_YJ_KY_HXKT + _RY（dc/dzje/gxd） | ⌊到账/万⌋×A1.5/B1.2/C1 ×gxd/100；须 sftgjdhys='是' |
| 成果转化 | V_RSC_CGZH(_MX) | DA022_YJ_KY_CGZH + _RY | 到账×A2/B1.5/C1.2/D1 每万 ×gxd/100，前3位 |
| 专利软著 | V_RSC_KY_ZL(_MX) | DA022_YJ_KY_ZL + _RY（zllx/wc） | 发明4(1/0.8/0.5前3)、实用/外观2(同)、软著1(1/0.7前2) |
| 成果奖 | V_RSC_KY_CGHJ(_MX) | DA022_YJ_KY_CGHJ + _RY（cglx≠'教材'） | 码表(lx='教科研成果奖'，级别×等次×位次) |
| 教材奖 | V_RSC_KY_JCJ(_MX) | DA022_YJ_KY_CGHJ + _RY（cglx='教材'） | 码表(lx='教材奖') |

## 五、岗位工作业绩分（上限20；按序列取两项，各上限10）

| 序列 | 单项 | 视图 | 底层表 | 算法 |
|---|---|---|---|---|
| 教学 | 教学评价 | V_RSC_JXPJ | DA022_YJ_JXPJ_DDKH + _SDKH | avg本人分/max**本人**分×5 各一项（注意：分母是本人 max，非全员最高，基本人人满分——口径存疑，排查时声明） |
| 教学 | 实践项目 | V_RSC_JXSJXM(_MX_JXSJXM/_GXYTH) | DA022_YJ_JXSJXM + _LXCYR；DA022_YJ_GXYTHPYMS + _LXCYR | 码表(lx='教学实践项目'，档次×级别)×gxd/100 |
| 教学 | 大赛 | V_RSC_JXSJXM_MX_JXJS(_YSF) | DA022_YJ_JSJS + _JSCY（jslx/jsdj/hjdj/rylb/tdbl/jscbdw） | 码表(教学竞赛/世赛系列/其他竞赛/金砖)×参赛1/指导0.8×本院承办0.6×tdbl/100；同赛项同角色取最高，指导教师第2位起=0 |
| 学工 | 学工考核 | V_RSC_XGKH(_XGKHZGL) | DA022_YJ_XGKH_GZL + _GZZL（psnd） | 直接汇总学工部录入的工作量分+质量分 |
| 学工 | 职业能力提升 | V_RSC_ZYNLTS(_MX) | DA022_YJ_ZJNLTS（dj/hjdj/lx/qz） | 码表(lx='职业能力提升')×qz；视图排除100165 |
| 学工 | 指导学生竞赛 | V_RSC_ZDXSCS(_MX) | DA022_YJ_ZDXSCS（dj/hjdj/jslb/lx） | 码表(lx='指导学生竞赛和实践活动')；心理健康活动→实践活动类别 |
| 管辅 | 岗位工作考核 | V_RSC_GWGZKHJG | ANNUAL_DA_EVALUATION_RESULT(type_='GWGZ') | avg(score)；**review_id 硬编码** 2c9000aa94437f44019642ddc3d5000f |
| 管辅 | 服务质量考核 | V_RSC_FWZLKH | 同上(type_='FWZL') | avg(score)；同上硬编码 |

## 六、评议类（办法占总分10%+10%）

民主测评/领导评议：ANNUAL_DA_EVALUATION_RESULT(type_='MZCP')，is_leader='1'→领导评议、'0'→民测（V_RSC_MZCP，review_id 硬编码）。当轮未开展按 0。

## 七、汇总与标准分层（了解即可）

> 版本情报（2026-11 经职称评审MCP核实 user_objects）：正式库 2025-09-13 完成 GWJP_FS→ZCPS_FS 更名；**2026-09-10 新增 `_2026` 后缀一代**（V_ZCPS_FS_TJJG_2026 / FXBZF_2026 / MAX_2026 / GXYSF_2026 / BM_2026，仅正式库有），2026 轮标准分测算应优先核对 `_2026` 版；V_RSC_KY_JCJ 最近一次 DDL 为 2026-10-28。
>
> `_2026` 流水线：`ZCPS_YSFJG_2026`(2026原始分结果表,year='2026',已灌56人) + `V_ZCPS_BM_2026`(da129_zcps 按 ss_process.create_time>='2026' 圈名单) → GXYSF_2026(五大类汇总) → MAX_2026(序列×级别最高分) → FXBZF_2026(归一法标准分) → TJJG_2026(总分=标准分×0.8+民测+领导)。
>
> 已知隐患：① TJJG_2026 关联的 `V_RSC_MZCP` 仍是 review_id 硬编码(...5000e, 2025年度)的旧视图，2026 民测开展后必须同步更新，否则总分民测/领导部分取旧值；② BM_2026 的 WHERE `(ING) OR (FINISH AND 2026创建)` 因 AND 优先于 OR，实际圈入所有年份的在办申报，历史 IN 状态记录会污染 2026 名单。

单项 → `T_ZCPS_SCORE_TEA`/`ZCPS_YSFJG`(a1..ec2) → `V_ZCPS_FS_MAX`(序列×级别最高分) → `V_ZCPS_FS_FXBZF`(归一法,上限15/25/10/30/20) → `V_ZCPS_FS_TJJG`(总分=标准分×0.8+民测+领导)。摸底原始分测算不走这层。

## 八、关键码表 ZJB_RSC_DM

列：LX(规则类) / JB(级别) / HJDJ(等次) / WC(位次) / LB(类别) / FZ(分值)。lx 取值：纵向课题、教科研成果奖、教材奖、教学实践项目、职业能力提升、指导学生竞赛和实践活动。查分值示例：`SELECT fz FROM ZJB_RSC_DM WHERE lx='教科研成果奖' AND jb='省级' AND hjdj='二等奖' AND wc='2'`。
