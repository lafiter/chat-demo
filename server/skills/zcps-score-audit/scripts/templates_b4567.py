# -*- coding: utf-8 -*-
"""b4~b7 批量测算 SQL 模板（2026 轮实测验证）。由 build_queries.py 调用，参数由其 CONFIG 传入。"""

def q_b4(ps, md, CUTOFF_GZL, CUTOFF_YEJI, NDMAX):
    return md(ps, ('zgh', 'rdsj')) + """,
bzr AS (SELECT zgh, SUM(score) s FROM (
 (SELECT d.zgh,(CASE WHEN d.sf='兼职' THEN (CASE WHEN d.xss=40 THEN 0.5 WHEN d.xss>40 AND d.xss<=100 THEN 0.5+0.01*(d.xss-40)
    WHEN d.xss>=30 AND d.xss<=39 THEN 0.4 WHEN d.xss>=20 AND d.xss<=29 THEN 0.3 WHEN d.xss<20 THEN 0.1 WHEN d.xss>100 THEN 1.1 END)
  WHEN d.sf='兼职副班主任' THEN (CASE WHEN d.xss=16 THEN 0.5 WHEN d.xss>16 AND d.xss<=40 THEN 0.5+0.01*(d.xss-16)
    WHEN d.xss>=12 AND d.xss<=16 THEN 0.4 WHEN d.xss>=8 AND d.xss<=12 THEN 0.3 WHEN d.xss<8 THEN 0.1 WHEN d.xss>40 THEN 1.1 END) END)
  *(CASE WHEN d.rzys=4 THEN 1 WHEN d.rzys>=2 AND d.rzys<4 THEN 0.5 WHEN d.rzys<2 THEN 0 END) score
  FROM (SELECT t.zgh,sf,bjlx,rzys,SUM(CASE WHEN bjlx='鲁甘合作' THEN 2*to_number(xss)
    WHEN bjlx='高职院校联合培养大专班' THEN 40 ELSE to_number(xss) END) xss
   FROM DA022_YJ_FDYDB t, ss_process sh, md sj WHERE sh.id=t.id AND sj.zgh=t.zgh AND t.xn IS NOT NULL AND t.xq IS NOT NULL
     AND sf IN ('兼职','兼职副班主任') AND substr(sj.rdsj,0,4)<substr(t.xn,0,4) AND sh.process_result='AGREE' AND sh.process_status='FINISH'
     AND CASE WHEN t.xq='02' THEN substr(t.xn,-4)||'-01' ELSE substr(t.xn,0,4)||'-07' END<='CG_PH'
   GROUP BY t.zgh,sf,bjlx,rzys) d
  UNION ALL SELECT d.zgh,(CASE WHEN d.xss=40 THEN 0.5 WHEN d.xss>40 AND d.xss<=100 THEN 0.5+0.01*(d.xss-40)
    WHEN d.xss>=30 AND d.xss<=39 THEN 0.4 WHEN d.xss>=20 AND d.xss<=29 THEN 0.3 WHEN d.xss<20 THEN 0.1 WHEN d.xss>100 THEN 1.1 END)*d.xs score
  FROM (SELECT t.zgh,sf,bjlx,rzys,CASE WHEN COUNT(0)>2 THEN 1 ELSE 0 END xs,
    ROUND(AVG(CASE WHEN bjlx='鲁甘合作' THEN 2*to_number(xss) WHEN bjlx='高职院校联合培养大专班' THEN 40 ELSE to_number(xss) END)) xss
   FROM DA022_YJ_FDYDB t, ss_process sh, md sj WHERE sh.id=t.id AND sj.zgh=t.zgh AND t.xn IS NOT NULL AND t.xq IS NOT NULL
     AND sf='专职' AND substr(sj.rdsj,0,4)<substr(t.xn,0,4) AND sh.process_result='AGREE' AND sh.process_status='FINISH'
     AND CASE WHEN t.xq='02' THEN substr(t.xn,-4)||'-01' ELSE substr(t.xn,0,4)||'-07' END<='CG_PH'
   GROUP BY t.zgh,sf,bjlx,rzys) d)) GROUP BY zgh),
lsbzr AS (SELECT u.zgh, ROUND(SUM(NVL(u.jbgzlf,'0')+NVL(u.gzzlf,'0')),2) s FROM
 (SELECT t.*, b.rdsj, substr(t.xn,0,4)||'-'||CASE t.yf WHEN '三月' THEN '03' WHEN '四月' THEN '04' WHEN '五月' THEN '05'
    WHEN '六月' THEN '06' WHEN '九月' THEN '09' WHEN '十月' THEN '10' WHEN '十一月' THEN '11' WHEN '十二月' THEN '12' END kssj
  FROM DA022_YJ_BZRDB_LS t, ss_process a, md b WHERE t.sf='兼职' AND a.id=t.id AND t.zgh=b.zgh
    AND a.process_status||a.process_result='FINISHAGREE'
    AND substr(t.xn,0,4)||'-'||CASE t.yf WHEN '三月' THEN '03' WHEN '四月' THEN '04' WHEN '五月' THEN '05'
    WHEN '六月' THEN '06' WHEN '九月' THEN '09' WHEN '十月' THEN '10' WHEN '十一月' THEN '11' WHEN '十二月' THEN '12' END<='CG_PH') u
 WHERE u.rdsj<=u.kssj GROUP BY u.zgh),
sx AS (SELECT v.zgh, ROUND(SUM(v.score),2) s FROM
 (SELECT t.zgh,(CASE WHEN t.khdc IS NULL THEN 1 WHEN t.khdc='优秀' THEN 1.2 WHEN t.khdc='良好' THEN 1.1
    WHEN t.khdc='合格' THEN 1.0 WHEN t.khdc='基本合格' THEN 0.8 ELSE 0 END)
   *(CASE WHEN t.sxlx='工学交替' THEN (CASE WHEN to_number(t.sxxss)<=60 THEN 0.2 WHEN to_number(t.sxxss)>60 THEN (t.sxxss-60)*0.002+0.2 END)
     WHEN t.sxlx='岗位实习' THEN (CASE WHEN to_number(t.sxxss)<=120 THEN 0.2 WHEN to_number(t.sxxss)>120 THEN (t.sxxss-120)*0.001+0.2 END) END) score
  FROM DA022_YJ_SXXSGL t, md sj, ss_process sh WHERE sh.id=t.id AND sj.zgh=t.zgh AND sh.process_result='AGREE'
    AND sh.process_status='FINISH' AND sj.rdsj<=t.jssj AND t.jssj<='CD_PH'
  UNION ALL SELECT a.c_alrr zgh, 0.2*(CASE WHEN to_number(a.c_fk8i)>=40 THEN 0.5+(to_number(a.c_fk8i)-40)*0.01
    WHEN to_number(a.c_fk8i)>=30 THEN 0.4 WHEN to_number(a.c_fk8i)>=20 THEN 0.3 WHEN to_number(a.c_fk8i)>=0 THEN 0.1 ELSE 0 END) score
  FROM DA022_YJ_SXXSGL_G_ORIG a, DA022_YJ_SXXSGL t, md sj, ss_process sh WHERE sh.id=t.id AND t.id=a.process_id
    AND sj.zgh=a.c_alrr AND t.sxlx='工学交替' AND sh.process_result='AGREE' AND sh.process_status='FINISH'
    AND sj.rdsj<=t.jssj AND t.jssj<='CD_PH') v GROUP BY v.zgh),
px AS (SELECT w.zgh, ROUND(SUM(w.kh*w.score*w.xs),2) s FROM
 (SELECT t.zgh,t.nd,(CASE WHEN (CASE WHEN t.khdc='优秀' THEN 1.2 WHEN t.khdc='良好' THEN 1.1 WHEN t.khdc='合格' THEN 1.0
     WHEN t.khdc='基本合格' THEN 0.8 WHEN t.khdc='不合格' THEN 0 END) IS NULL THEN 1
   ELSE (CASE WHEN t.khdc='优秀' THEN 1.2 WHEN t.khdc='良好' THEN 1.1 WHEN t.khdc='合格' THEN 1.0
     WHEN t.khdc='基本合格' THEN 0.8 WHEN t.khdc='不合格' THEN 0 END) END) kh,
   NVL(SUM(CASE WHEN t.wcpxrs>=40 THEN 0.125 WHEN t.wcpxrs>=30 AND t.wcpxrs<=39 THEN 0.1
     WHEN t.wcpxrs>=20 AND t.wcpxrs<=29 THEN 0.05 END),0) score,
   ROUND(SUM(CASE WHEN to_number(t.pxxss)>=30 THEN 1 WHEN to_number(t.pxxss)<30 THEN to_number(t.pxxss)/30 END),2) xs
  FROM DA022_YJ_PX t, md sj, ss_process sh WHERE sh.id=t.id AND sj.zgh=t.zgh AND sh.process_result='AGREE'
    AND sh.process_status='FINISH' AND substr(sj.rdsj,0,4)<=substr(t.nd,0,4) AND t.nd<='ND_PH'
  GROUP BY t.zgh,t.nd,CASE WHEN (CASE WHEN t.khdc='优秀' THEN 1.2 WHEN t.khdc='良好' THEN 1.1 WHEN t.khdc='合格' THEN 1.0
     WHEN t.khdc='基本合格' THEN 0.8 WHEN t.khdc='不合格' THEN 0 END) IS NULL THEN 1
   ELSE (CASE WHEN t.khdc='优秀' THEN 1.2 WHEN t.khdc='良好' THEN 1.1 WHEN t.khdc='合格' THEN 1.0
     WHEN t.khdc='基本合格' THEN 0.8 WHEN t.khdc='不合格' THEN 0 END) END) w GROUP BY w.zgh),
jj AS (SELECT q.zgh, ROUND(SUM(q.score*q.kh),2) s FROM
 (SELECT t.zgh, substr(t.nd,0,4) nd0, (CASE WHEN (CASE WHEN t.khdc='优秀' THEN 1.2 WHEN t.khdc='良好' THEN 1.1
     WHEN t.khdc='合格' THEN 1.0 WHEN t.khdc='基本合格' THEN 0.8 ELSE 0 END) IS NULL THEN 1
   ELSE (CASE WHEN t.khdc='优秀' THEN 1.2 WHEN t.khdc='良好' THEN 1.1 WHEN t.khdc='合格' THEN 1.0
     WHEN t.khdc='基本合格' THEN 0.8 ELSE 0 END) END) kh,
   (CASE WHEN to_number(t.rs)>=40 THEN 0.2 WHEN to_number(t.rs)>=30 AND to_number(t.rs)<=39 THEN 0.16
     WHEN to_number(t.rs)>=20 AND to_number(t.rs)<=29 THEN 0.12 END) score
  FROM DA022_YJ_JXJYXSGL t, md sj, ss_process sh WHERE sh.id=t.id AND sj.zgh=t.zgh AND sh.process_result='AGREE'
    AND sh.process_status='FINISH' AND substr(sj.rdsj,0,4)<=substr(t.nd,0,4)) q WHERE q.nd0<='ND_PH' GROUP BY q.zgh)
SELECT md.zgh, NVL(bzr.s,0) bzr, NVL(lsbzr.s,0) lsbzr, NVL(sx.s,0) sx, NVL(px.s,0) px, NVL(jj.s,0) jj
FROM md LEFT JOIN bzr ON md.zgh=bzr.zgh LEFT JOIN lsbzr ON md.zgh=lsbzr.zgh LEFT JOIN sx ON md.zgh=sx.zgh
LEFT JOIN px ON md.zgh=px.zgh LEFT JOIN jj ON md.zgh=jj.zgh ORDER BY md.zgh""".replace('CG_PH', CUTOFF_GZL).replace('CD_PH', CUTOFF_YEJI).replace('ND_PH', NDMAX)


def q_b5(ps, md, CUTOFF_YEJI):
    return md(ps, ('zgh', 'rdsj')) + """,
lw AS (SELECT t.zgh, SUM(t.score) s FROM
 (SELECT m.zgh zgh, CASE WHEN t.jb='A' AND m.wc<=4 THEN 15*(1-(m.wc-1)*0.2)
   WHEN t.jb='B' AND m.wc<=3 THEN 12*(CASE m.wc WHEN '1' THEN 1 WHEN '2' THEN 0.8 WHEN '3' THEN 0.5 ELSE 0 END) ELSE 0 END score
  FROM DA022_YJ_KY_LW t, DA022_YJ_KY_LW_RY m, ss_process a, md b WHERE b.rdsj<t.FBSJ AND b.zgh=m.zgh AND a.id=t.id
    AND m.process_id=t.id AND t.jb IN ('A','B') AND a.process_status||a.process_result='FINISHAGREE' AND t.fbsj<='CD_PH'
  UNION ALL SELECT x.zgh, x.score FROM (SELECT zgh, ROW_NUMBER() OVER(PARTITION BY zgh ORDER BY sc DESC) px, sc score FROM
   (SELECT m.zgh zgh, CASE WHEN t.jb='C' AND m.wc<=3 THEN 4*(1-(m.wc-1)*0.2) WHEN t.jb='D' AND m.wc<=3 THEN 3*(1-(m.wc-1)*0.2)
     WHEN t.jb='E' AND m.wc<=2 THEN 2*(1-(m.wc-1)*0.5) ELSE 0 END sc
    FROM DA022_YJ_KY_LW t, DA022_YJ_KY_LW_RY m, ss_process a, md b WHERE b.rdsj<t.FBSJ AND b.zgh=m.zgh AND a.id=t.id
      AND m.process_id=t.id AND t.jb IN ('C','D','E') AND a.process_status||a.process_result='FINISHAGREE' AND t.fbsj<='CD_PH')) x
   WHERE x.px<3) t GROUP BY t.zgh),
jczz AS (SELECT t.zgh, ROUND(SUM(t.score),2) s FROM
 (SELECT m.zgh zgh,(CASE WHEN t.jcjb='国家级规划教材' THEN (CASE m.cbjs WHEN '第一主编' THEN 15 WHEN '其余主编' THEN 12
     WHEN '副主编' THEN 10 WHEN '编委' THEN 5 WHEN '主审' THEN 7.5 END)
   WHEN t.jcjb='省级规划教材' THEN (CASE m.cbjs WHEN '第一主编' THEN 10 WHEN '其余主编' THEN 8
     WHEN '副主编' THEN 7 WHEN '编委' THEN 3 WHEN '主审' THEN 5 END) END)
   *(CASE WHEN m.cbjs='主审' THEN 20000 ELSE TO_NUMBER(m.cbzs) END)/20000
   *LEAST(1, CASE WHEN m.cbjs='主审' THEN 1 ELSE TO_NUMBER(m.cbzs)/20000 END) score
  FROM DA022_YJ_KY_JCZZ t, DA022_YJ_KY_JCZZ_RY m, ss_process a, md b WHERE b.rdsj<t.CBSJ AND b.zgh=m.zgh AND a.id=t.id
    AND m.process_id=t.id AND t.jcjb IN ('国家级规划教材','省级规划教材')
    AND a.process_status||a.process_result='FINISHAGREE' AND t.cbsj<='CD_PH'
  UNION ALL SELECT x.zgh, x.score FROM (SELECT zgh, ROW_NUMBER() OVER(PARTITION BY zgh ORDER BY sc DESC) px, sc score FROM
   (SELECT m.zgh zgh,(CASE WHEN t.jcjb='国家级出版社出版' THEN (CASE m.cbjs WHEN '第一主编' THEN 10 WHEN '其余主编' THEN 8
       WHEN '副主编' THEN 7 WHEN '编委' THEN 3 WHEN '主审' THEN 5 END)
     WHEN t.jcjb='其他级别出版社' THEN (CASE m.cbjs WHEN '第一主编' THEN 6 WHEN '其余主编' THEN 5
       WHEN '副主编' THEN 4 WHEN '编委' THEN 2 WHEN '主审' THEN 3 END)
     WHEN t.jcjb='校本教材' THEN (CASE m.cbjs WHEN '第一主编' THEN 4 WHEN '其余主编' THEN 3
       WHEN '副主编' THEN 2 WHEN '编委' THEN 1 WHEN '主审' THEN 2 END) END)
     *LEAST((CASE WHEN m.cbjs='主审' THEN 20000 ELSE TO_NUMBER(m.cbzs) END)/20000,1) sc
    FROM DA022_YJ_KY_JCZZ t, DA022_YJ_KY_JCZZ_RY m, ss_process a, md b WHERE b.rdsj<t.CBSJ AND b.zgh=m.zgh AND a.id=t.id
      AND m.process_id=t.id AND t.jcjb NOT IN ('国家级规划教材','省级规划教材')
      AND a.process_status||a.process_result='FINISHAGREE' AND t.cbsj<='CD_PH')) x WHERE x.px<3) t GROUP BY t.zgh),
zl AS (SELECT m.zgh, SUM(CASE WHEN t.zllx='发明专利' THEN 4*(CASE m.wc WHEN '1' THEN 1 WHEN '2' THEN 0.8 WHEN '3' THEN 0.5 ELSE 0 END)
   WHEN t.zllx IN ('外观设计专利','实用新型专利') THEN 2*(CASE m.wc WHEN '1' THEN 1 WHEN '2' THEN 0.8 WHEN '3' THEN 0.5 ELSE 0 END)
   WHEN t.zllx='软件著作' THEN 1*(CASE m.wc WHEN '1' THEN 1 WHEN '2' THEN 0.7 ELSE 0 END) END) s
  FROM DA022_YJ_KY_ZL t, DA022_YJ_KY_ZL_RY m, ss_process a, md b WHERE b.rdsj<t.ZLSQSJ AND b.zgh=m.zgh AND a.id=t.id
    AND m.process_id=t.id AND a.process_status||a.process_result='FINISHAGREE' AND t.zlsqsj<='CD_PH' GROUP BY m.zgh),
cghj AS (SELECT t.zgh, SUM(NVL(a.fz,'0')) s FROM
 (SELECT t2.hjdj hjdj,t2.hjdc hjdc,m2.zgh zgh,m2.wc wc FROM DA022_YJ_KY_CGHJ t2, DA022_YJ_KY_CGHJ_RY m2, ss_process p2, md b2
   WHERE b2.rdsj<t2.HJSJ AND b2.zgh=m2.zgh AND p2.id=t2.id AND m2.process_id=t2.id AND t2.cglx!='教材'
     AND p2.process_status||p2.process_result='FINISHAGREE' AND t2.hjsj<='CD_PH') t
 LEFT JOIN ZJB_RSC_DM a ON a.jb=t.hjdj AND a.hjdj=t.hjdc AND t.wc=a.wc AND a.lx='教科研成果奖' GROUP BY t.zgh),
jcj AS (SELECT t.zgh, SUM(NVL(a.fz,'0')) s FROM
 (SELECT t2.hjdj hjdj,t2.hjdc hjdc,m2.zgh zgh,m2.wc wc FROM DA022_YJ_KY_CGHJ t2, DA022_YJ_KY_CGHJ_RY m2, ss_process p2, md b2
   WHERE b2.rdsj<t2.HJSJ AND b2.zgh=m2.zgh AND p2.id=t2.id AND m2.process_id=t2.id AND t2.cglx='教材'
     AND p2.process_status||p2.process_result='FINISHAGREE' AND t2.hjsj<='CD_PH') t
 LEFT JOIN ZJB_RSC_DM a ON a.jb=t.hjdj AND a.hjdj=t.hjdc AND t.wc=a.wc AND a.lx='教材奖' GROUP BY t.zgh)
SELECT md.zgh, NVL(lw.s,0) lw, NVL(jczz.s,0) jczz, NVL(zl.s,0) zl, NVL(cghj.s,0) cghj, NVL(jcj.s,0) jcj
FROM md LEFT JOIN lw ON md.zgh=lw.zgh LEFT JOIN jczz ON md.zgh=jczz.zgh LEFT JOIN zl ON md.zgh=zl.zgh
LEFT JOIN cghj ON md.zgh=cghj.zgh LEFT JOIN jcj ON md.zgh=jcj.zgh ORDER BY md.zgh""".replace('CD_PH', CUTOFF_YEJI)


def q_b6(ps, md, CUTOFF_YEJI):
    return md(ps, ('zgh', 'dj', 'rdsj')) + """,
zxkt AS (SELECT u.zgh, SUM(u.KT) s FROM
 (SELECT t.zgh, SUM(NVL(a.fz,'0')+FLOOR(t.ktjf/10000)*2) KT FROM
   (SELECT b.dj, t.JB, CASE WHEN b.dj||t.JB='zgj校级' THEN '0' WHEN t.jfly='自筹' THEN '0'
      WHEN m.wc='1' THEN t.ktjf ELSE '0' END ktjf, m.zgh,
      CASE WHEN b.dj||t.JB='zgj校级' THEN '20' ELSE m.wc END wc
    FROM DA022_YJ_KT_ZXKT t, DA022_YJ_KT_ZXKT_RY m, ss_process a, md b WHERE b.rdsj<t.JTSJ AND b.dj||t.JB!='fgj校级'
      AND b.zgh=m.zgh AND a.id=t.id AND m.process_id=t.id
      AND a.process_status||a.process_result='FINISHAGREE' AND t.jtsj<='CD_PH') t
  LEFT JOIN ZJB_RSC_DM a ON a.jb=t.JB AND t.wc=a.wc AND a.lx='纵向课题' GROUP BY t.zgh
  UNION ALL SELECT x.zgh, x.KT FROM (SELECT t.zgh, t.KT, ROW_NUMBER() OVER(PARTITION BY t.zgh ORDER BY t.KT DESC) px FROM
   (SELECT t.zgh, SUM(NVL(a.fz,'0')+FLOOR(t.ktjf/10000)*2) KT FROM
     (SELECT b.dj, t.JB, CASE WHEN b.dj||t.JB='zgj校级' THEN '0' WHEN t.jfly='自筹' THEN '0'
        WHEN m.wc='1' THEN t.ktjf ELSE '0' END ktjf, m.zgh,
        CASE WHEN b.dj||t.JB='zgj校级' THEN '20' ELSE m.wc END wc
      FROM DA022_YJ_KT_ZXKT t, DA022_YJ_KT_ZXKT_RY m, ss_process a, md b WHERE b.rdsj<t.JTSJ AND b.dj||t.JB='fgj校级'
        AND b.zgh=m.zgh AND a.id=t.id AND m.process_id=t.id
        AND a.process_status||a.process_result='FINISHAGREE' AND t.jtsj<='CD_PH') t
    LEFT JOIN ZJB_RSC_DM a ON a.jb=t.JB AND t.wc=a.wc AND a.lx='纵向课题' GROUP BY t.zgh) t) x WHERE x.px<=2) u GROUP BY u.zgh),
hxkt AS (SELECT t.zgh, SUM(CASE t.dc WHEN 'A' THEN FLOOR(t.dzje/10000)*1.5*t.gxd/100
   WHEN 'B' THEN FLOOR(t.dzje/10000)*1.2*t.gxd/100 WHEN 'C' THEN FLOOR(t.dzje/10000)*1*t.gxd/100 END) s
  FROM (SELECT t.ktjf,t.jddj,m.zgh,m.wc,m.gxd,t.dzje,t.dc FROM DA022_YJ_KY_HXKT t, DA022_YJ_KY_HXKT_RY m, ss_process a, md b
    WHERE b.rdsj<t.JTSJ AND b.zgh=m.zgh AND a.id=t.id AND m.process_id=t.id AND t.sftgjdhys='是'
      AND a.process_status||a.process_result='FINISHAGREE' AND t.jtsj<='CD_PH') t GROUP BY t.zgh),
cgzh AS (SELECT m.zgh, SUM((CASE t.dc WHEN 'A' THEN 2*t.dzje/10000 WHEN 'B' THEN 1.5*t.dzje/10000
   WHEN 'C' THEN 1.2*t.dzje/10000 WHEN 'D' THEN 1*t.dzje/10000 END)*m.gxd/100) s
  FROM DA022_YJ_KY_CGZH t, DA022_YJ_KY_CGZH_RY m, ss_process a, md b WHERE b.rdsj<t.WCSJ AND b.zgh=m.zgh AND a.id=t.id
    AND m.process_id=t.id AND m.wc<4 AND a.process_status||a.process_result='FINISHAGREE' AND t.wcsj<='CD_PH' GROUP BY m.zgh)
SELECT md.zgh, NVL(zxkt.s,0) zxkt, NVL(hxkt.s,0) hxkt, NVL(cgzh.s,0) cgzh
FROM md LEFT JOIN zxkt ON md.zgh=zxkt.zgh LEFT JOIN hxkt ON md.zgh=hxkt.zgh
LEFT JOIN cgzh ON md.zgh=cgzh.zgh ORDER BY md.zgh""".replace('CD_PH', CUTOFF_YEJI)


def q_b7(ps, md, CUTOFF_YEJI):
    return md(ps, ('zgh', 'rdsj')) + """,
sjxm AS (SELECT t.zgh, SUM(NVL(a.fz,'0')*NVL(t.gxd,'0')/100) s FROM
 (SELECT t.xmjb jb, t.xmdc dc, m.zgh zgh, m.gxd gxd FROM DA022_YJ_JXSJXM t, DA022_YJ_JXSJXM_LXCYR m, ss_process a, md b
   WHERE b.rdsj<=t.LXSJ AND b.zgh=m.zgh AND a.id=t.id AND m.process_id=t.id AND t.lxsj<='CD_PH'
     AND a.process_status||a.process_result='FINISHAGREE'
  UNION ALL SELECT t.jb, t.dc, m.zgh, m.gxd FROM DA022_YJ_GXYTHPYMS t, DA022_YJ_GXYTHPYMS_LXCYR m, ss_process a, md b
   WHERE b.rdsj<=t.LXSJ AND b.zgh=m.zgh AND a.id=t.id AND m.process_id=t.id AND t.lxsj<='CD_PH'
     AND a.process_status||a.process_result='FINISHAGREE') t
 LEFT JOIN ZJB_RSC_DM a ON a.jb=t.jb AND a.hjdj=t.dc AND a.lx='教学实践项目' GROUP BY t.zgh),
jsjs AS (SELECT u.zgh, SUM(u.score) s FROM
 (SELECT CASE WHEN p.px>1 AND p.rylb='指导教师' THEN 0 ELSE p.score END score, p.zgh FROM
  (SELECT v.zgh, v.rylb, ROW_NUMBER() OVER(PARTITION BY v.zgh,v.jslx,v.jssj,v.jszbdw,v.rylb ORDER BY
     NVL(a.fz,'0')*(CASE WHEN v.rylb='参赛教师' THEN 1 ELSE 0.8 END)
     *(CASE WHEN v.jscbdw LIKE '%山东医药技师%' THEN 0.6 ELSE 1 END)*NVL(v.tdbl,'0')/100 DESC) px,
     NVL(a.fz,'0')*(CASE WHEN v.rylb='参赛教师' THEN 1 ELSE 0.8 END)
     *(CASE WHEN v.jscbdw LIKE '%山东医药技师%' THEN 0.6 ELSE 1 END)*NVL(v.tdbl,'0')/100 score
   FROM (SELECT m.zgh zgh, m.rylb rylb, t.jslx jslx, t.jssj jssj, t.jszbdw jszbdw, t.jsdj jsdj, t.hjdj hjdj, t.jscbdw jscbdw, m.tdbl tdbl
     FROM DA022_YJ_JSJS t, DA022_YJ_JSJS_JSCY m, ss_process p, md b WHERE b.rdsj<=t.JSSJ AND b.zgh=m.zgh AND p.id=t.id
       AND m.process_id=t.id AND t.jssj<='CD_PH' AND p.process_status||p.process_result='FINISHAGREE') v
   LEFT JOIN ZJB_RSC_DM a ON ((a.jb=v.jslx AND a.lx='世赛系列职业技能竞赛')
     OR (a.lb='金砖国家职业技能大赛' AND a.hjdj=DECODE(v.hjdj,'金牌','一等奖','银牌','二等奖','铜牌','三等奖',v.hjdj) AND v.jslx='金砖国家职业技能大赛')
     OR (a.jb=v.jsdj AND a.lx='教学竞赛' AND a.hjdj=DECODE(v.hjdj,'金牌','一等奖','银牌','二等奖','铜牌','三等奖',v.hjdj) AND v.jslx='教学竞赛')
     OR (a.jb=v.jsdj AND a.lx='其他竞赛' AND a.hjdj=DECODE(v.hjdj,'金牌','一等奖','银牌','二等奖','铜牌','三等奖',v.hjdj)
        AND CASE WHEN v.jslx='科普创作大赛' THEN '二类' ELSE v.jslx END=a.lb AND v.jslx IN ('一类','二类','创新创业大赛','科普创作大赛')))) p) u
 GROUP BY u.zgh),
zynl AS (SELECT t.zgh, ROUND(SUM(NVL(a.fz*CASE WHEN TO_NUMBER(NVL(t.qz,'1'))>1 THEN TO_NUMBER(t.qz)/100
     ELSE TO_NUMBER(NVL(t.qz,'1')) END,'0')),5) s
  FROM (SELECT t.* FROM DA022_YJ_ZJNLTS t, ss_process a, md b WHERE b.rdsj<=t.BSSJ AND b.zgh=t.zgh AND a.id=t.id
    AND t.bssj<='CD_PH' AND a.process_status||a.process_result='FINISHAGREE') t
  LEFT JOIN ZJB_RSC_DM a ON a.jb=t.DJ AND a.hjdj=t.HJDJ AND t.LX=a.lb AND a.lx='职业能力提升'
  WHERE t.zgh!='100165' GROUP BY t.zgh),
zdxs AS (SELECT t.zgh, SUM(NVL(a.fz,'0')) s FROM
 (SELECT t.DJ DJ, t.HJDJ HJDJ, CASE WHEN t.LX='心理健康活动' THEN '实践活动' ELSE t.JSLB END lb, t.zgh zgh
  FROM DA022_YJ_ZDXSCS t, ss_process a, md b WHERE b.rdsj<t.BSSJ AND b.zgh=t.zgh AND a.id=t.id
    AND t.bssj<='CD_PH' AND a.process_status||a.process_result='FINISHAGREE') t
 LEFT JOIN ZJB_RSC_DM a ON a.jb=t.DJ AND a.hjdj=t.HJDJ AND t.lb=a.lb AND a.lx='指导学生竞赛和实践活动' GROUP BY t.zgh)
SELECT md.zgh, NVL(sjxm.s,0) sjxm, NVL(jsjs.s,0) jsjs, NVL(zynl.s,0) zynl, NVL(zdxs.s,0) zdxs
FROM md LEFT JOIN sjxm ON md.zgh=sjxm.zgh LEFT JOIN jsjs ON md.zgh=jsjs.zgh
LEFT JOIN zynl ON md.zgh=zynl.zgh LEFT JOIN zdxs ON md.zgh=zdxs.zgh ORDER BY md.zgh""".replace('CD_PH', CUTOFF_YEJI)
