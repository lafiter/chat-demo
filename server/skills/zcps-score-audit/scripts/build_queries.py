# -*- coding: utf-8 -*-
"""按当轮名单生成 7 个批量测算 SQL（走职称评审 MCP 中继执行）。

用法:
    python build_queries.py <名单.xlsx> <输出目录>
产出: 输出目录/b1.sql ~ b7.sql（b1=学历, b2=质量, b3=本职+党政, b4=学生管理, b5=专业A, b6=专业B, b7=岗位业绩）

轮次参数集中在下方 CONFIG，每年评审季更新。名单格式沿用
"5.量化摸底人员xxxx.xlsx"（两个sheet：辅系列/主系列，列布局两sheet不同——辅系列序号在B列，主系列在A列）。
"""
import sys, os, datetime, re
import openpyxl

# ============ 轮次 CONFIG（每年更新） ============
CUTOFF_YEJI = '2026-10-31'   # 业绩/任职年限截止
CUTOFF_GZL = '2026-06'       # 教学工作量/学生管理截止（月）
CQ_YEAR_MAX = '2025'         # 辅系列出勤按完整年度至该年
RZ_CUTOFF = '2026-10'        # 任职年限截止月
FORM_JXGZL = '11981c45708c482ca98370e31ee99568'  # 教学工作量表单 code
# ================================================

LEVEL = {'三级': 3, '四级': 4, '五级': 5, '六级': 6, '七级': 7, '八级': 8, '九级': 9, '十级': 10, '十一级': 11, '十二级': 12}
DJ = {3: 'zgj', 4: 'zgj', 5: 'fgj', 6: 'fgj', 7: 'fgj', 8: 'zj', 9: 'zj', 10: 'zj', 11: 'cj', 12: 'cj'}

def rdsj_str(v):
    if isinstance(v, datetime.datetime):
        return v.strftime('%Y-%m')
    return str(v).split('(')[0].split('（')[0].strip()[:7]

def load_roster(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    people = []
    for ws in wb.worksheets:
        fu = ws.title == '辅系列'
        xl = '02' if fu else '01'
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i == 0:
                continue
            if fu:
                if row[1] is None: continue
                try: no = int(row[1])
                except (TypeError, ValueError): continue
                vals = [row[2], row[3], row[4], row[5], row[6], row[7], row[8]]
            else:
                if row[0] is None: continue
                try: no = int(row[0])
                except (TypeError, ValueError): continue
                vals = [row[1], row[2], row[3], row[4], row[5], row[6], row[7]]
            gh = '' if vals[2] is None else str(vals[2]).split('.')[0]
            jpgw = str(vals[5])
            m = re.search(r'(三级|四级|五级|六级|七级|八级|九级|十级|十一级|十二级)', jpgw)
            lv = LEVEL.get(m.group(1), 12) if m else 12
            people.append(dict(zgh=gh, xl=xl, dj=DJ[lv], rdsj=rdsj_str(vals[6])))
    return people

def md(people, cols):
    """生成内联名单 CTE。cols: 需要的列 ('zgh','xl','dj','rdsj')；Oracle 每个分支都要 FROM dual"""
    parts = ["SELECT " + ','.join("'%s' %s" % (people[0][c], c) for c in cols) + " FROM dual"]
    for p in people[1:]:
        parts.append(" UNION ALL SELECT " + ','.join("'%s'" % p[c] for c in cols) + " FROM dual")
    return 'WITH md AS (' + ''.join(parts) + ')'

APPROVE = "p.process_status||p.process_result='FINISHAGREE'"  # 注意各表别名可能不是p，模板内已具体化

def q_b1(ps):  # 学历（任职年限在本地算，不查库）
    return md(ps, ('zgh',)) + """,
b AS (SELECT t.c_zgh zgh,
  CASE WHEN c_jxjyxl IS NOT NULL AND c_jxjyxl!='无' THEN c_jxjyxl
       WHEN c_yjsxl IS NOT NULL AND c_yjsxl!='无' THEN c_yjsxl
       WHEN c_bkxl IS NOT NULL AND c_bkxl!='无' THEN c_bkxl ELSE '' END xl,
  CASE WHEN c_jxjyxw IS NOT NULL AND c_jxjyxw!='无' THEN c_jxjyxw
       WHEN c_yjsxw IS NOT NULL AND c_yjsxw!='无' THEN c_yjsxw
       WHEN c_bkxw IS NOT NULL AND c_bkxw!='无' THEN c_bkxw ELSE '' END xw
  FROM DA022_T_JSJBXX t, ss_process a WHERE a.id=t.id AND a.process_status||a.process_result='FINISHAGREE'),
s AS (SELECT zgh, MAX(CASE WHEN xl='大学专科' THEN 1 WHEN xl='本科' AND xw IS NULL THEN 3
  WHEN xl='本科' AND xw='学士' THEN 4 WHEN xl='本科' AND xw='硕士' THEN 5
  WHEN xl='研究生' AND xw='硕士' THEN 7 WHEN xl='研究生' AND xw='博士' THEN 9 ELSE 0 END) xlf FROM b GROUP BY zgh)
SELECT md.zgh, NVL(s.xlf,0) xlf FROM md LEFT JOIN s ON md.zgh=s.zgh ORDER BY md.zgh"""

def q_b2(ps):  # 工作质量：表彰/奖励/考核优秀/支持发展
    return md(ps, ('zgh', 'rdsj')) + """,
bz AS (SELECT zgh, SUM(score) s FROM (SELECT d.zgh, d.bznd, MAX(d.sc) score FROM
 (SELECT t.zgh, t.bzlb, substr(t.bzsj,0,4) bznd,
   CASE WHEN t.bzdj LIKE '%国%' THEN 16 WHEN t.bzdj LIKE '%省%' THEN 12 WHEN t.bzdj LIKE '%厅级%' THEN 8
        WHEN t.bzdj LIKE '%市级%' THEN 4 WHEN t.bzdj LIKE '%校%' THEN 2 END sc
  FROM DA022_YJ_BZ t, ss_process a, md b WHERE b.rdsj < t.bzsj AND b.zgh=t.zgh AND a.id=t.id
    AND t.bzsj<='{C1}' AND a.process_status||a.process_result='FINISHAGREE'
  UNION ALL
  SELECT t.zgh,'通报表扬',substr(t.TBSJ,0,4),
   CASE WHEN t.bydj LIKE '%国%' THEN 8 WHEN t.bydj LIKE '%省%' THEN 6 WHEN t.bydj LIKE '%市、厅%' THEN 4
        WHEN t.bydj LIKE '%市局、委%' THEN 2 WHEN t.bydj LIKE '%校%' THEN 1 END sc
  FROM DA022_YJ_BZ_BY t, ss_process a, md b WHERE b.rdsj < t.TBSJ AND b.zgh=t.zgh AND a.id=t.id
    AND t.TBSJ<='{C1}' AND a.process_status||a.process_result='FINISHAGREE') d
 GROUP BY d.zgh, d.bznd) GROUP BY zgh),
jl AS (SELECT t.zgh, SUM(CASE WHEN t.jldj IN ('记大功','记功') THEN 6 WHEN t.jldj='嘉奖' THEN 2 END) s
  FROM DA022_YJ_JL t, ss_process a, md b WHERE b.rdsj < t.nd||'-12-31' AND b.zgh=t.zgh AND a.id=t.id
    AND t.nd||'-12-31'<='{C1}' AND a.process_status||a.process_result='FINISHAGREE' GROUP BY t.zgh),
ndkh AS (SELECT zgh, SUM(score) s FROM
 (SELECT t.zgh, 2 score FROM DA022_YJ_NDKH t, ss_process a, md b
    WHERE b.rdsj < t.nd||'-12-31' AND b.zgh=t.zgh AND a.id=t.id AND t.nd||'-12-31'<='{C1}'
      AND a.process_status||a.process_result='FINISHAGREE' AND t.khdc='优秀'
  UNION ALL SELECT t.zgh, 4 FROM DA022_YJ_PQKH t, ss_process a, md b
    WHERE b.rdsj < t.nd||'-12-31' AND b.zgh=t.zgh AND a.id=t.id AND t.nd||'-12-31'<='{C1}'
      AND a.process_status||a.process_result='FINISHAGREE' AND t.khdc='优秀') GROUP BY zgh),
zcxy AS (SELECT zgh, SUM(score) s FROM
 (SELECT t.zgh, SUM(NVL(t.ys,0)*0.2) score FROM DA022_YJ_WPGZ t, ss_process a, md b
    WHERE a.id=t.id AND t.kssj IS NOT NULL AND t.zgh=b.zgh AND t.kssj<='{CRZ}'
      AND a.process_status||a.process_result='FINISHAGREE' GROUP BY t.zgh
  UNION ALL SELECT d.zgh, LEAST(ROUND(SUM(d.score)/COUNT(1),2),3) score FROM
   (SELECT zgh, nd, score FROM (SELECT t.zgh, t.nd,
      CASE WHEN (t.sjwcs-t.zsrws)>=0 THEN (t.sjwcs-t.zsrws)*0.2 ELSE 0 END score,
      ROW_NUMBER() OVER(PARTITION BY t.zgh ORDER BY t.nd DESC) px
    FROM DA022_YJ_ZSRW t, ss_process a, md b WHERE b.rdsj < t.nd||'-12-31' AND b.zgh=t.zgh AND a.id=t.id
      AND t.nd||'-12-31'<='{C1}' AND a.process_status||a.process_result='FINISHAGREE') WHERE px<=3) d
   GROUP BY d.zgh
  UNION ALL SELECT t.zgh, LEAST(SUM(t.zsrs)*0.1,3) score FROM DA022_YJ_JXJYZS t, ss_process a, md b
    WHERE b.rdsj < t.nd||'-12-31' AND b.zgh=t.zgh AND a.id=t.id AND t.nd||'-12-31'<='{C1}'
      AND a.process_status||a.process_result='FINISHAGREE' GROUP BY t.zgh) GROUP BY zgh)
SELECT md.zgh, NVL(bz.s,0) bz, NVL(jl.s,0) jl, NVL(ndkh.s,0) ndkh, NVL(zcxy.s,0) zcxy
FROM md LEFT JOIN bz ON md.zgh=bz.zgh LEFT JOIN jl ON md.zgh=jl.zgh
LEFT JOIN ndkh ON md.zgh=ndkh.zgh LEFT JOIN zcxy ON md.zgh=zcxy.zgh ORDER BY md.zgh""".replace('{C1}', CUTOFF_YEJI).replace('{CRZ}', RZ_CUTOFF)

# b3/b4/b5/b6/b7 模板较长，结构与单点排查模板一致（见 references/query-patterns.md），
# 由 main() 从 patterns 文件读取——为保证单文件可执行，下面内置精简等价版。
def q_b3(ps):  # 本职工作量+党政
    return md(ps, ('zgh', 'xl', 'rdsj')) + """,
jxgzl AS (SELECT t.zgh, ROUND(SUM(J2)/160,2) s FROM (SELECT e.*, CASE
   WHEN e.kssj>=e.rdsj THEN 1
   WHEN substr(e.kssj,0,4)=substr(e.rdsj,0,4) AND substr(e.kssj,6,2)='01' AND substr(e.rdsj,6,2) IN ('01','02','03') THEN 1
   WHEN substr(e.kssj,0,4)=substr(e.rdsj,0,4) AND substr(e.kssj,6,2)='01' AND substr(e.rdsj,6,2) IN ('04','05','06') THEN (7-to_number(substr(e.rdsj,6,2)))/4
   WHEN substr(e.kssj,0,4)=substr(e.rdsj,0,4) AND substr(e.kssj,6,2)='07' AND substr(e.rdsj,6,2) IN ('07','08','09') THEN 1
   WHEN substr(e.kssj,0,4)=substr(e.rdsj,0,4) AND substr(e.kssj,6,2)='07' AND substr(e.rdsj,6,2) IN ('10','11','12') THEN (13-to_number(substr(e.rdsj,6,2)))/4
   ELSE 0 END*e.jxgzl J2
 FROM (SELECT t.zgh, t.jxgzl, CASE WHEN t.xq='02' THEN substr(t.xn,-4)||'-01' ELSE substr(t.xn,0,4)||'-07' END kssj, b.rdsj
   FROM DA022_YJ_JXGZL t, ss_process a, md b WHERE a.id=t.id AND b.xl='01' AND t.zgh=b.zgh
     AND a.form_code='{F}' AND a.process_status||a.process_result='FINISHAGREE'
     AND CASE WHEN t.xq='02' THEN substr(t.xn,-4)||'-01' ELSE substr(t.xn,0,4)||'-07' END<='{CG}') e) t GROUP BY t.zgh),
cq AS (SELECT t.zgh, GREATEST(10-(FLOOR(SUM(t.sjts)/5)*0.5+FLOOR(SUM(t.bjts)/10)*0.5+SUM(t.qxhdcs)*0.1),0) s
  FROM DA022_YJ_JSCQQK t, ss_process a, md b WHERE a.id=t.id AND b.zgh=t.zgh AND b.xl='02'
    AND b.rdsj<t.nd||'-12-31' AND t.nd<='{CY}' AND a.process_status||a.process_result='FINISHAGREE' GROUP BY t.zgh),
jzgz AS (SELECT t.zgh, ROUND(SUM(CASE
   WHEN t.kssj>=b.rdsj THEN (MONTHS_BETWEEN(TO_DATE(NVL(t.jssj,'{CRZ}'),'yyyy-mm'),TO_DATE(t.kssj,'yyyy-mm'))+1)/12
   WHEN t.kssj<b.rdsj AND b.rdsj<NVL(t.jssj,'{CRZ}') THEN (MONTHS_BETWEEN(TO_DATE(NVL(t.jssj,'{CRZ}'),'yyyy-mm'),TO_DATE(b.rdsj,'yyyy-mm'))+1)/12
   ELSE 0 END * CASE t.zwjb WHEN '院领导' THEN 3 WHEN '中层正职' THEN 2.4 WHEN '中层副职' THEN 1.8
     WHEN '科员' THEN 1.2 WHEN '团总支书记' THEN 1.2 WHEN '系办主任' THEN 1.2 WHEN '教辅人员' THEN 1.2
     WHEN '班主任' THEN 1.2 WHEN '辅导员' THEN 1.2 ELSE 0 END),2) s
  FROM DA022_T_JS_GZJL t, ss_process a, md b WHERE b.zgh=t.zgh AND a.id=t.id
    AND (t.jssj>t.kssj OR t.jssj IS NULL) AND t.kssj<='{CRZ}'
    AND a.process_status||a.process_result='FINISHAGREE' GROUP BY t.zgh)
SELECT md.zgh, NVL(jxgzl.s,0) jxgzl, NVL(cq.s,0) cq, NVL(jzgz.s,0) jzgz
FROM md LEFT JOIN jxgzl ON md.zgh=jxgzl.zgh LEFT JOIN cq ON md.zgh=cq.zgh
LEFT JOIN jzgz ON md.zgh=jzgz.zgh ORDER BY md.zgh""".replace('{F}', FORM_JXGZL).replace('{CG}', CUTOFF_GZL).replace('{CRZ}', RZ_CUTOFF).replace('{CY}', CQ_YEAR_MAX)

def main():
    roster_xlsx, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    ps = load_roster(roster_xlsx)
    print('名单人数:', len(ps))
    import templates_b4567 as tb
    ndmax = str(int(CUTOFF_YEJI[:4]))
    qs = {
        'b1': q_b1(ps),
        'b2': q_b2(ps),
        'b3': q_b3(ps),
        'b4': tb.q_b4(ps, md, CUTOFF_GZL, CUTOFF_YEJI, ndmax),
        'b5': tb.q_b5(ps, md, CUTOFF_YEJI),
        'b6': tb.q_b6(ps, md, CUTOFF_YEJI),
        'b7': tb.q_b7(ps, md, CUTOFF_YEJI),  # zynl 已内置 QZ>1 按÷100 换算
    }
    for name, sql in qs.items():
        with open(os.path.join(outdir, name + '.sql'), 'w', encoding='utf-8') as f:
            f.write(sql)
    print('已生成:', ', '.join(sorted(qs)))

if __name__ == '__main__':
    main()
