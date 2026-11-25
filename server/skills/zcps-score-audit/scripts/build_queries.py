# -*- coding: utf-8 -*-
"""按当轮名单生成 7 个批量测算 SQL（走职称评审 MCP 中继执行）。

用法:
    python build_queries.py <名单.xlsx> <输出目录>
产出: 输出目录/b1.sql ~ b7.sql（b1=学历, b2=质量, b3=本职+党政, b4=学生管理, b5=专业A, b6=专业B, b7=岗位业绩）

SQL 模板与本轮参数在 ../scoring/（sql-templates.json、round-config.json），与服务端 calc_raw_score 工具
共用同一份：改口径只改那两个文件，本脚本不用动。名单格式沿用
"5.量化摸底人员xxxx.xlsx"（两个sheet：辅系列/主系列，列布局两sheet不同——辅系列序号在B列，主系列在A列）。
"""
import sys, os, datetime, re, json
import openpyxl

# ============ 轮次 CONFIG 与 SQL 模板（scoring/ 目录，与服务端共用；每年评审季更新） ============
SCORING_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scoring')
with open(os.path.join(SCORING_DIR, 'round-config.json'), encoding='utf-8') as _f:
    _ROUND = json.load(_f)
with open(os.path.join(SCORING_DIR, 'sql-templates.json'), encoding='utf-8') as _f:
    _TEMPLATES = json.load(_f)['batches']

CUTOFF_YEJI = _ROUND['cutoffYeji']   # 业绩/任职年限截止
CUTOFF_GZL = _ROUND['cutoffGzl']     # 教学工作量/学生管理截止（月）
CQ_YEAR_MAX = _ROUND['cqYearMax']    # 辅系列出勤按完整年度至该年
RZ_CUTOFF = _ROUND['rzCutoff']       # 任职年限截止月
FORM_JXGZL = _ROUND['formJxgzl']     # 教学工作量表单 code
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

def _sql(name, ps, **extra):
    """套模板：{MD}=内联名单 CTE，其余标记为本轮参数（与服务端 src/scoring.ts 的填法一致）"""
    batch = _TEMPLATES[name]
    sql = batch['sql'].replace('{MD}', md(ps, tuple(batch['mdCols'])))
    values = {'CUTOFF_YEJI': CUTOFF_YEJI, 'CUTOFF_GZL': CUTOFF_GZL, 'CQ_YEAR_MAX': CQ_YEAR_MAX,
              'RZ_CUTOFF': RZ_CUTOFF, 'FORM_JXGZL': FORM_JXGZL, 'ND_MAX': str(int(CUTOFF_YEJI[:4]))}
    values.update(extra)
    for key, value in values.items():
        sql = sql.replace('{%s}' % key, value)
    return sql

def q_b1(ps):  # 学历（任职年限在本地算，不查库）
    return _sql('b1', ps)

def q_b2(ps):  # 工作质量：表彰/奖励/考核优秀/支持发展
    return _sql('b2', ps)

def q_b3(ps):  # 本职工作量+党政
    return _sql('b3', ps)

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
