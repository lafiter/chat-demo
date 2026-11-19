# 排查 SQL 模板（经 2026-11 摸底实测验证）

通用约定：`:zgh` 为工号；`:rdsj` 为起聘月('YYYY-MM')；截止按当轮（示例用 2026 轮：业绩 2026-10-31 / 工作量 2026-06-30）。全部走 `mcp__oracle-intern__execute_query`，schema 前缀 ``。11g 语法：分页用 `WHERE ROWNUM<=n`。

## 0. 定位人（重名核对）

```sql
SELECT t.c_zgh, t.c_xm, t.c_ssbm FROM DA022_T_JSJBXX t
WHERE t.c_xm LIKE '%张伟%' AND ROWNUM<=10
-- 或查名单/报名表
SELECT c_zgh, xm, series_id, jslb FROM da129_zcps WHERE xm LIKE '%张伟%'
```

## 1. 任职年限 —— 直接按名单口径复算

```
任职年限分 = (MONTHS_BETWEEN(截止月, 起聘月) + 1) × 0.1    -- 首尾月都算
```
库口径（对比用）：查 `V_RSC_RZNX`（注意依赖 annual_review_info(GWJP) 年度配置，2026 未建则查不出）。
聘任史原始记录：`DA022_T_JSJBXX_G_5O1I`(c_zgh, c_ovuz 聘任等级, c_m7xd 起始月) + `ZJB_RSC_PRDJ`(等级码表)。

## 2. 表彰（含通报表扬、同年同类取最高）

```sql
SELECT t.zgh, t.bzmc, t.bzdj, t.bzlb, t.bzsj, p.process_status||p.process_result st,
       CASE WHEN t.bzdj LIKE '%国%' THEN 16 WHEN t.bzdj LIKE '%省%' THEN 12
            WHEN t.bzdj LIKE '%厅级%' THEN 8 WHEN t.bzdj LIKE '%市级%' THEN 4
            WHEN t.bzdj LIKE '%校%' THEN 2 END fz
FROM DA022_YJ_BZ t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
UNION ALL
SELECT t.zgh, t.tbmc, t.bydj, '通报表扬', t.tbsj, p.process_status||p.process_result,
       CASE WHEN t.bydj LIKE '%国%' THEN 8 WHEN t.bydj LIKE '%省%' THEN 6
            WHEN t.bydj LIKE '%市、厅%' THEN 4 WHEN t.bydj LIKE '%市局、委%' THEN 2
            WHEN t.bydj LIKE '%校%' THEN 1 END
FROM DA022_YJ_BZ_BY t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
```
汇总：按 (bzlb, 年度=substr(时间,0,4)) 取 max 再求和；窗口 `:rdsj < 时间 <= 截止`。

## 3. 论文 / 教材 / 专利 / 课题 / 成果奖 —— 同构模板

```sql
-- 论文明细（其余单项换表和分值列即可）
SELECT t.lwmc, t.jb, t.fbsj, m.wc 位次, p.process_status||p.process_result st
FROM DA022_YJ_KY_LW t, DA022_YJ_KY_LW_RY m, ss_process p
WHERE p.id=t.id AND m.process_id=t.id AND m.zgh=:zgh
  AND p.process_status||p.process_result='FINISHAGREE' AND t.fbsj<='2026-10-31' AND :rdsj < t.fbsj
ORDER BY t.fbsj
```
表与时间列速查：论文 _KY_LW(fbsj) / 教材 _KY_JCZZ(cbsj) / 纵题 _KT_ZXKT(jtsj) / 横题 _KY_HXKT(jtsj) / 转化 _KY_CGZH(wcsj) / 专利 _KY_ZL(zlsqsj) / 成果奖 _KY_CGHJ(hjsj, 注意 cglx='教材' 是教材奖)。
码表类分值（纵题/成果奖/教材奖）用 `ZJB_RSC_DM` 取 fz（见 rules-mapping.md 第八节）。

## 4. 培训 / 继教（考核为空=系数1！）

```sql
SELECT t.zgh, t.nd, t.wcpxrs, t.pxxss, t.khdc, p.process_status||p.process_result st
FROM DA022_YJ_PX t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
-- 计分: 人数档(0.125/0.1/0.05) × 学时系数(⌊30学时⌋) × NVL(考核系数,1)
```

## 5. 支持学院发展（三张表拆开看）

```sql
SELECT '外派' src, t.gzlx, t.kssj, t.jssj, t.ys FROM DA022_YJ_WPGZ t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
UNION ALL
SELECT '招生', t.nd, t.zsrws, t.sjwcs, NULL FROM DA022_YJ_ZSRW t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
UNION ALL
SELECT '继教', t.nd, t.zsrs, NULL, NULL FROM DA022_YJ_JXJYZS t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
-- 计分: 外派月×0.2；招生=近3年(聘任后)平均超额×0.2 上限3；继教=人数×0.1 上限3
```

## 6. 教学工作量（主系列）

```sql
SELECT t.xn, t.xq, t.jxgzl, p.process_status||p.process_result st
FROM DA022_YJ_JXGZL t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.form_code='11981c45708c482ca98370e31ee99568'
  AND p.process_status||p.process_result='FINISHAGREE'
-- Σ(学期起始月<=2026-06 的 jxgzl×年内折算系数)/160
```

## 7. 岗位业绩类

```sql
-- 教学评价(督导/师德)
SELECT '督导' src, t.xn, t.xq, t.fz FROM DA022_YJ_JXPJ_DDKH t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
UNION ALL SELECT '师德', t.xn, t.xq, t.fz FROM DA022_YJ_JXPJ_SDKH t, ss_process p
WHERE p.id=t.id AND t.zgh=:zgh AND p.process_status||p.process_result='FINISHAGREE'
-- 大赛/实践项目/职业能力/指导学生竞赛: DA022_YJ_JSJS(+_JSCY) / _JXSJXM(+_LXCYR) / _GXYTHPYMS(+_LXCYR) / _ZJNLTS / _ZDXSCS，分值查码表
-- 岗位考核/服务考核/民测: ANNUAL_DA_EVALUATION_RESULT (type_, object_id=zgh, review_id 注意硬编码)
SELECT r.type_, AVG(r.score) FROM ANNUAL_DA_EVALUATION_RESULT r
WHERE r.object_id=:zgh AND r.review_id='2c9000aa94437f44019642ddc3d5000f' GROUP BY r.type_
```

## 8. 审批状态分布（整类 0 分时先跑这个）

```sql
SELECT p.process_status||p.process_result st, COUNT(*) FROM <业绩表> t, ss_process p
WHERE p.id=t.id GROUP BY p.process_status||p.process_result
```

## 9. 历史教训（务必避免）

- 修数据文件时按"字段数"正则批量替换会**误伤同格式数据块**（2026-11 曾把支持发展/成果奖覆盖成培训分），改完必须逐值校验；
- 派生表必须显式起别名再引用（ORA-00904 高发）；CASE 各分支类型要一致（字数等字符列需 TO_NUMBER）；
- 查 `V_RSC_GWJP_JSXX` 的 rdsj 时记住 4 人硬编码（200121/100258/100265/100032）；
- 评议类视图 review_id 写死，换年度先核对。
