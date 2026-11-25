# -*- coding: utf-8 -*-
"""b4~b7 批量测算 SQL（2026 轮实测验证）。由 build_queries.py 调用，参数由其 CONFIG 传入。

SQL 模板在 ../scoring/sql-templates.json（与服务端 calc_raw_score 工具共用同一份）；
本模块只负责套名单、填参数，不再各自保存 SQL 文本。
"""
import os, json

SCORING_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scoring')
with open(os.path.join(SCORING_DIR, 'sql-templates.json'), encoding='utf-8') as _f:
    _TEMPLATES = json.load(_f)['batches']


def _sql(name, ps, md, **values):
    batch = _TEMPLATES[name]
    sql = batch['sql'].replace('{MD}', md(ps, tuple(batch['mdCols'])))
    for key, value in values.items():
        sql = sql.replace('{%s}' % key, value)
    return sql


def q_b4(ps, md, CUTOFF_GZL, CUTOFF_YEJI, NDMAX):
    return _sql('b4', ps, md, CUTOFF_GZL=CUTOFF_GZL, CUTOFF_YEJI=CUTOFF_YEJI, ND_MAX=NDMAX)


def q_b5(ps, md, CUTOFF_YEJI):
    return _sql('b5', ps, md, CUTOFF_YEJI=CUTOFF_YEJI)


def q_b6(ps, md, CUTOFF_YEJI):
    return _sql('b6', ps, md, CUTOFF_YEJI=CUTOFF_YEJI)


def q_b7(ps, md, CUTOFF_YEJI):
    return _sql('b7', ps, md, CUTOFF_YEJI=CUTOFF_YEJI)
