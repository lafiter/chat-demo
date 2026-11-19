# -*- coding: utf-8 -*-
"""合并 7 批查询结果 + 名单，生成 v9 版式的原始分测算 Excel（现场库口径）。

用法:
    python merge_final.py <名单.xlsx> <结果目录> <输出.xlsx>

结果目录需包含 b1.json ~ b7.json，每个文件是中继返回的 rows 数组（list of dict，
键为大写字段名），如 [{"ZGH":"100013","XLF":3}, ...]。字段约定：
  b1: ZGH,XLF                                  学历
  b2: ZGH,BZ,JL,NDKH,ZCXY                      表彰/奖励/考核优秀/支持发展
  b3: ZGH,JXGZL,CQ,JZGZ                        本职教学/出勤/党政
  b4: ZGH,BZR,LSBZR,SX,PX,JJ                   班主任/历史班主任/实习/培训/继教
  b5: ZGH,LW,JCZZ,ZL,CGHJ,JCJ                  论文/教材/专利/成果奖/教材奖
  b6: ZGH,ZXKT,HXKT,CGZH                       纵向/横向/成果转化
  b7: ZGH,SJXM,JSJS,ZYNL,ZDXS                  实践项目/大赛/职业能力/指导竞赛(ZYNL应为QZ换算后)
"""
import sys, os, json, datetime, re
from decimal import Decimal, ROUND_HALF_UP
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter, column_index_from_string

RZ_CUTOFF = '2026-10'  # 任职年限截止月（与 build_queries.py CONFIG 同步更新）

def r2(x):
    return float(Decimal(str(x)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))

def load_batch(d, name, fields):
    path = os.path.join(d, name + '.json')
    rows = json.load(open(path, encoding='utf-8'))
    out = {}
    for row in rows:
        z = str(row.get('ZGH') or row.get('zgh'))
        out[z] = [float(row.get(f) or 0) for f in fields]
    return out

def rdsj_str(v):
    if isinstance(v, datetime.datetime):
        return v.strftime('%Y-%m')
    return str(v).split('(')[0].split('（')[0].strip()[:7]

def load_roster(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    roster = []
    for ws in wb.worksheets:
        fu = ws.title == '辅系列'
        xl = '辅系列' if fu else '主系列'
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
            roster.append([xl, no, str(vals[0]), str(vals[1]), gh, str(vals[3]), str(vals[5]), rdsj_str(vals[6])])
    for r in roster:
        if not r[4]:
            r[4] = '200119'
    return roster

LEVEL = {'三级': 3, '四级': 4, '五级': 5, '六级': 6, '七级': 7, '八级': 8, '九级': 9, '十级': 10, '十一级': 11, '十二级': 12}
seqname = {'教学序列': 'JX', '学工序列': 'XG', '管理和辅助序列': 'GF'}
jsname = {'JX': '教学', 'XG': '学工', 'GF': '管理辅助'}

def main():
    roster_xlsx, resdir, out_xlsx = sys.argv[1], sys.argv[2], sys.argv[3]
    b1 = load_batch(resdir, 'b1', ('XLF',))
    b2 = load_batch(resdir, 'b2', ('BZ', 'JL', 'NDKH', 'ZCXY'))
    b3 = load_batch(resdir, 'b3', ('JXGZL', 'CQ', 'JZGZ'))
    b4 = load_batch(resdir, 'b4', ('BZR', 'LSBZR', 'SX', 'PX', 'JJ'))
    b5 = load_batch(resdir, 'b5', ('LW', 'JCZZ', 'ZL', 'CGHJ', 'JCJ'))
    b6 = load_batch(resdir, 'b6', ('ZXKT', 'HXKT', 'CGZH'))
    b7 = load_batch(resdir, 'b7', ('SJXM', 'JSJS', 'ZYNL', 'ZDXS'))

    cy, cm = int(RZ_CUTOFF[:4]), int(RZ_CUTOFF[5:7])
    people = []
    for r in load_roster(roster_xlsx):
        zgh = r[4][:6]
        if zgh not in b1:
            print('警告: 名单中的人不在 b1 结果里(学历缺失按0):', r[2], zgh)
        xlf = b1.get(zgh, [0])[0]
        ry, rm = int(r[7][:4]), int(r[7][5:7])
        rznx = r2((cy * 12 + cm - (ry * 12 + rm) + 1) * 0.1)
        jcf = r2(rznx + xlf)
        q = b2.get(zgh, [0, 0, 0, 0])
        gzzlf = r2(sum(q))
        w = b3.get(zgh, [0, 0, 0])
        m = b4.get(zgh, [0, 0, 0, 0, 0])
        gzlf = r2(sum(w) + sum(m))
        a = b5.get(zgh, [0, 0, 0, 0, 0])
        bz6 = b6.get(zgh, [0, 0, 0])
        zygzf = r2(sum(a) + sum(bz6))
        g = b7.get(zgh, [0, 0, 0, 0])
        js = seqname.get(r[5], 'GF')
        if js == 'JX':
            gw = r2(g[0] + g[1]); cols = [0.0, r2(g[0] + g[1]), 0.0, 0.0, 0.0, 0.0]
        elif js == 'XG':
            gw = r2(g[2] + g[3]); cols = [0.0, 0.0, 0.0, r2(g[2] + g[3]), 0.0, 0.0]
        else:
            gw = 0.0; cols = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        total = r2(jcf + gzlf + gzzlf + zygzf + gw)
        people.append((r, js, jcf, gzlf, gzzlf, zygzf, gw, total, rznx, xlf, w, m, q, a, bz6, g, cols))

    def lv(s):
        mm = re.search(r'(三级|四级|五级|六级|七级|八级|九级|十级|十一级|十二级)', s)
        return LEVEL.get(mm.group(1), 99) if mm else 99
    people.sort(key=lambda p: (0 if p[0][0] == '主系列' else 1, lv(p[0][6]), -p[7]))

    out = openpyxl.Workbook()
    ws = out.active
    ws.title = '原始分测算'
    tf = Font(bold=True, size=11)
    zf_font = Font(bold=True, size=12, color='C00000')
    hf = PatternFill('solid', fgColor='DDEBF7')
    zf_fill = PatternFill('solid', fgColor='FCE4D6')
    sf = PatternFill('solid', fgColor='F2F2F2')
    sd = Side(style='thin', color='999999')
    bd = Border(left=sd, right=sd, top=sd, bottom=sd)
    ct = Alignment(horizontal='center', vertical='center', wrap_text=True)
    lt = Alignment(horizontal='left', vertical='center')
    headers = ['序列', '序号', '姓名', '部门', '工号', '岗位序列', '拟竞聘岗位', '起聘时间', '原始分总分',
               '任职年限分', '学历分', '基础分小计',
               '本职教学工作量', '辅系列出勤', '党政管理', '班主任', '历史班主任', '实习管理', '培训', '继教', '工作量小计',
               '表彰', '奖励', '考核优秀', '支持发展', '工作质量小计',
               '论文', '教材著作', '纵向课题', '横向课题', '成果转化', '专利软著', '成果奖', '教材奖', '专业业绩小计',
               '教学评价', '实践项目与大赛', '学工考核', '职业能力与指导竞赛', '岗位工作考核', '服务质量考核', '岗位业绩小计',
               '民主测评', '领导评议']
    ws.append(headers)
    for c in ws[1]:
        c.font = tf; c.fill = hf; c.alignment = ct; c.border = bd
    for (r, js, jcf, gzlf, gzzlf, zygzf, gw, total, rznx, xlf, w, m, q, a, bz6, g, cols) in people:
        row = [r[0], r[1], r[2], r[3], r[4], jsname[js], r[6], r[7], total,
               rznx, r2(xlf), jcf, r2(w[0]), r2(w[1]), r2(w[2]), r2(m[0]), r2(m[1]), r2(m[2]), r2(m[3]), r2(m[4]), gzlf,
               r2(q[0]), r2(q[1]), r2(q[2]), r2(q[3]), gzzlf,
               r2(a[0]), r2(a[1]), r2(bz6[0]), r2(bz6[1]), r2(bz6[2]), r2(a[2]), r2(a[3]), r2(a[4]), zygzf,
               cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], gw, 0.0, 0.0]
        ws.append(row)
        lr = ws[ws.max_row]
        for c in lr:
            c.border = bd; c.alignment = ct
        for c in lr[8:]:
            c.number_format = '0.00'
        for ci in (3, 4, 7):
            lr[ci - 1].alignment = lt
        for ci in (9, 12, 21, 26, 35, 42, 43, 44):
            lr[ci - 1].font = Font(bold=True)
            lr[ci - 1].fill = sf
        lr[8].font = zf_font
        lr[8].fill = zf_fill
    widths = [7, 5, 11, 15, 9, 9, 24, 11, 11] + [8] * 35
    for i, wd in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = wd
    ws.insert_rows(1); ws.insert_rows(1)

    def paint(rng, name, color, font=None):
        aa, bb = rng.split(':')
        ca = re.match(r'([A-Z]+)', aa).group(1)
        cb = re.match(r'([A-Z]+)', bb).group(1)
        for rr in (1, 2):
            for ci in range(column_index_from_string(ca), column_index_from_string(cb) + 1):
                cell = ws.cell(row=rr, column=ci)
                cell.fill = PatternFill('solid', fgColor=color)
                cell.border = bd
        if ca != cb:
            ws.merge_cells(rng)
        c = ws[aa]
        c.value = name
        c.font = font or Font(bold=True, size=11)
        c.alignment = ct

    paint('A1:H2', '基本信息', 'FFFFFF')
    paint('I1:I2', '原始分总分', 'FCE4D6', Font(bold=True, size=11, color='C00000'))
    paint('J1:L2', '基础分', 'D9E1F2')
    paint('M1:U2', '工作量分', 'E2EFDA')
    paint('V1:Z2', '工作质量分', 'FFF2CC')
    paint('AA1:AI2', '专业工作业绩分', 'FBE5D6')
    paint('AQ1:AR2', '民主测评/领导评议（默认0）', 'F2F2F2')
    paint('AJ1:AP1', '岗位工作业绩分', 'E4DFEC')
    paint('AJ2:AK2', '教学序列', 'E4DFEC')
    paint('AL2:AM2', '学工序列', 'E4DFEC')
    paint('AN2:AO2', '管理和辅助序列', 'E4DFEC')
    paint('AP2:AP2', '小计', 'E4DFEC', Font(bold=True, size=10))
    ws.freeze_panes = 'F4'

    ws2 = out.create_sheet('测算口径说明')
    ws2.append(['职称评聘量化摸底·原始分测算（现场库，由 zcps-score-audit scripts 生成 ' + datetime.date.today().isoformat() + '）'])
    for line in [
        '', '数据来源：山东医药技师学院现场平台（职称评审MCP中继，数据源"表单工作站"）',
        '名单：以当轮名单文件为准；起聘时间取名单列',
        '计分规则：与《量化办法》及 V_RSC_* 计分视图一致（docs/职称评聘量化计分规则对应关系.md）',
        '截止：业绩/任职年限 ' + RZ_CUTOFF + '；教学工作量/学生管理至 ' + RZ_CUTOFF[:4] + '-06（以 build_queries.py CONFIG 为准）',
        '审批口径：SS_PROCESS 为 FINISH+AGREE',
        '评议类六项默认0；培训/继教考核空值按系数1；职业能力 QZ>1 按÷100 换算（b7 SQL 内置）',
        '排序：主系列在前→拟竞聘岗位等级（高→低）→原始分总分倒序；不做标准分折算',
    ]:
        ws2.append([line])
    ws2.column_dimensions['A'].width = 120
    ws2['A1'].font = Font(bold=True, size=13)

    out.save(out_xlsx)
    bad = [p[0][2] for p in people if abs(round(p[2] + p[3] + p[4] + p[5] + p[6], 2) - p[7]) > 0.005]
    print('已生成', out_xlsx, '数据行:', len(people), '合计校验异常:', bad)

if __name__ == '__main__':
    main()
