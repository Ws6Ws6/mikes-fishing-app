"""Full per-lake accuracy audit (2026-10-28).
Inputs: data/lakes.geojson, data/contours.geojson (app), DNR FeatureServer layer0 contours + layer1 NHD outlines,
OSM water polygons, TIGER county lookup, DNR PDF table (cached in /workspace/audit28)."""
import json,pickle,re,sys,collections,csv,math
import numpy as np, shapely
from shapely.geometry import shape,Point,LineString,MultiLineString
from shapely.ops import unary_union
from shapely.strtree import STRtree
from pyproj import Transformer
A='/workspace/audit28/'
DATA=sys.argv[1] if len(sys.argv)>1 else 'data/'
OUT=sys.argv[2] if len(sys.argv)>2 else 'audit/accuracy_2026-10-28.csv'
T=Transformer.from_crs(4326,32616,always_xy=True)
def P(g): return shapely.transform(g,lambda c:np.column_stack(T.transform(c[:,0],c[:,1])))
norm=lambda s:re.sub(r'[^a-z0-9]','',(s or '').lower().replace('lake','').replace('the',''))
NORMC=lambda s:(s or '').lower().replace('kosciusco','kosciusko').replace(' county','')
lakes=json.load(open(DATA+'lakes.geojson'))['features']
cont=json.load(open(DATA+'contours.geojson'))['features']
polys=pickle.load(open(A+'polys.pkl','rb'))
pg=[P(p[2]) for p in polys]; ptree=STRtree(pg)
tiger=json.load(open(A+'tiger_county.json'))
pdft=json.load(open(A+'dnr_pdf_table.json'))
pdf_urls={r['url'] for r in pdft if r['url']}
fs=json.load(open(A+'fs_contours_ne.geojson'))['features']
fsl=[];fsp=[]
for f in fs:
    if not f['geometry']: continue
    g=P(shape(f['geometry']));fsl.append(g);fsp.append(f['properties'])
fstree=STRtree(fsl)
fsby=collections.defaultdict(lambda:{'lv':set(),'max':set(),'acres':set(),'dates':set(),'counties':set()})
for p in fsp:
    e=fsby[norm(p['lake_name'])];e['lv'].add(p['contour']);e['max'].add(p['lake_max_depth']);e['acres'].add(p['lake_acres']);e['dates'].add(p['survey_date']);e['counties'].update([NORMC(p['county1_name']),NORMC(p['county2_name'])])
byl=collections.defaultdict(list)
for f in cont: byl[f['properties']['lake_id']].append(f)
ids={f['properties']['id'] for f in lakes}
orphans=[k for k in byl if k not in ids]
rows=[];shoreof={}
for lf in lakes:
    L=lf['properties'];lid=L['id'];flags=[];r=dict(lake_id=lid,name=L['name'],county=L['county'])
    pt=P(Point(lf['geometry']['coordinates']))
    feats=byl.get(lid,[])
    lines=[];deps=[]
    for f in feats:
        g=P(shape(f['geometry']));d=f['properties']['depth_ft']
        if d is None: flags.append('DEPTHLESS_LINE');continue
        if g.geom_type=='MultiLineString' and any(p.length<0.01 for p in g.geoms):
            flags.append('DEGENERATE_PART');g=MultiLineString([p for p in g.geoms if p.length>=0.01])
        if g.is_empty or g.length<1: flags.append('DEGENERATE_LINE');continue
        lines.append(g);deps.append(d)
    r['n_lines']=len(lines);meth=collections.Counter(f['properties']['contour_method'] for f in feats)
    r['methods']='/'.join(f'{k}:{v}' for k,v in meth.items())
    lv=sorted(set(deps));r['app_levels']=' '.join(map(str,lv))
    if not lines: flags.append('NO_LINES');rows.append({**r,'status':'FLAG','flags':';'.join(flags)});continue
    allg=unary_union(lines)
    # --- shoreline polygon: water polygon containing most contour length
    cand=ptree.query(allg.envelope.buffer(200))
    best=None;bl=0
    for i in cand:
        w=pg[i]
        inside=allg.intersection(w.buffer(20)).length
        if inside>bl: bl=inside;best=i
    # also allow union of touching polygons with same name (multi-polygon lakes)
    S=pg[best] if best is not None else None
    r['shore_src']=polys[best][0] if best is not None else ''
    r['shore_name']=polys[best][1] if best is not None else ''
    tl=allg.length
    r['frac_inside']=round(bl/tl,3) if tl else None
    if S is not None:
        r['shore_acres']=round(S.area/4046.86,1)
        hull=shapely.concave_hull(shapely.MultiPoint(shapely.get_coordinates(allg)),ratio=0.15)
        r['hull_iou']=round(hull.intersection(S).area/hull.union(S).area,3)
        r['hull_cov']=round(hull.area/S.area,3)
        dpt=S.distance(pt);r['pt_to_shore_m']=round(dpt,1)
        if dpt>30: flags.append('POINT_OUTSIDE_LAKE %.0fm'%dpt)
        # point inside any water named like the lake?
        sn=norm(polys[best][1])
        if sn and sn!=norm(L['name']) and sn not in norm(L['name']) and norm(L['name']) not in sn: flags.append('SHORE_NAME_MISMATCH(%s)'%polys[best][1])
        if r['frac_inside']<0.95: flags.append('CONTOURS_OUTSIDE_SHORE frac=%.2f'%r['frac_inside'])
        if r['hull_cov']<0.25 and r['shore_acres']>5: flags.append('LOW_COVERAGE %.2f'%r['hull_cov'])
        if r['hull_cov']>1.15: flags.append('HULL_EXCEEDS_SHORE %.2f'%r['hull_cov'])
        # per-level median distance from shore (nesting proxy)
        B=S.boundary;med={}
        for d in lv:
            if d==0: continue
            gs=[g for g,dd in zip(lines,deps) if dd==d]
            pts=shapely.get_coordinates(unary_union(gs).segmentize(25))
            ds=shapely.distance(shapely.points(pts),B);med[d]=float(np.median(ds))
        ks=sorted(med);bad=[(a,b) for a,b in zip(ks,ks[1:]) if med[b]+15<med[a]]
        r['median_shore_dist_m']=' '.join('%s:%.0f'%(k,med[k]) for k in ks)
        if bad: flags.append('DEPTH_ORDER_INVERTED '+','.join('%s>%s'%(b,a) for a,b in bad))
        shoreof[lid]=(best,S)
    else: flags.append('NO_WATER_POLYGON')
    # --- contours / pin on the water body that carries this lake's name (OSM/NHD), if any nearby
    nn=norm(L.get('source_lake_name') or L['name'])
    cands=[i for i,pp in enumerate(polys) if pp[1] and (norm(pp[1])==nn or norm(pp[1])==norm(L['name'])) and pg[i].centroid.distance(pt)<40000]
    if cands:
        U=unary_union([pg[i] for i in cands]).buffer(30)
        r['frac_on_named_lake']=round(allg.intersection(U).length/allg.length,3)
        r['pin_to_named_lake_m']=round(unary_union([pg[i] for i in cands]).distance(pt),1)
        if r['frac_on_named_lake']<0.5: flags.append('CONTOURS_NOT_ON_NAMED_LAKE frac=%.2f'%r['frac_on_named_lake'])
        if r['pin_to_named_lake_m']>30: flags.append('PIN_NOT_ON_NAMED_LAKE %.0fm'%r['pin_to_named_lake_m'])
    else: r['frac_on_named_lake']=None
    # --- crossings between different-depth lines
    tr=STRtree(lines);cross=0;pairs=set()
    for i,g in enumerate(lines):
        for j in tr.query(g):
            if j<=i or deps[j]==deps[i]: continue
            if g.crosses(lines[j]):
                cross+=1;pairs.add(tuple(sorted((deps[i],deps[j]))))
    r['crossings']=cross
    if cross: flags.append('CONTOUR_CROSSINGS %d (%s)'%(cross,' '.join('%s/%s'%p for p in sorted(pairs)[:6])))
    # --- duplicates in same depth (identical lines)
    wk=collections.Counter((d,round(g.length),tuple(np.round(shapely.get_coordinates(g)[0],0))) for g,d in zip(lines,deps))
    dup=sum(v-1 for v in wk.values() if v>1)
    if dup: flags.append('DUPLICATE_LINES %d'%dup)
    r['dup_lines']=dup
    # --- FS comparison
    k=norm(L.get('source_lake_name') or L['name'])
    fsm=None
    for key in (norm(L.get('source_lake_name') or ''),norm(L['name'])):
        if key in fsby and NORMC(L['county']) in fsby[key]['counties']: fsm=fsby[key];break
    fsmax=max([x for x in (fsm['max'] if fsm else []) if x] or [0]) or None
    r['in_featureserver']=bool(fsm);r['fs_levels']=' '.join(map(str,sorted(x for x in fsm['lv'] if x is not None))) if fsm else ''
    r['fs_max_depth']=fsmax
    # depth agreement with FS lines (geometric): sample app vertices, nearest FS line within 20 m
    agree=tot=0;dis=collections.Counter()
    for g,d in zip(lines,deps):
        if d==0: continue
        pts=shapely.points(shapely.get_coordinates(g.segmentize(50))[::3])
        idx=fstree.query_nearest(pts,max_distance=15,all_matches=False)
        for pi,fi in zip(*idx):
            fd=fsp[fi]['contour']
            if fd==0 or fd is None: continue
            if norm(fsp[fi]['lake_name'])!=k and norm(fsp[fi]['lake_name'])!=norm(L['name']): continue
            tot+=1
            if fd==d: agree+=1
            else: dis[(d,fd)]+=1
    r['fs_overlap_pts']=tot;r['fs_depth_agree']=round(agree/tot,3) if tot else None
    if tot>=10 and agree/tot<0.9: flags.append('DEPTH_DISAGREES_WITH_FS %.2f (%s)'%(agree/tot,' '.join('app%s/fs%s' %kk for kk,_ in dis.most_common(4))))
    # --- max depth sanity
    mx=max(lv);r['app_max_contour']=mx;r['card_max_depth']=L.get('max_depth_ft')
    dmax=fsmax or L.get('max_depth_ft')
    iv=L.get('contour_interval_ft') or 10
    if L.get('max_depth_ft') and fsmax and L['max_depth_ft']!=fsmax: flags.append('CARD_MAX_%s_VS_FS_%s'%(L['max_depth_ft'],fsmax))
    if dmax and mx>dmax: flags.append('MAX_CONTOUR_%s_EXCEEDS_DNR_MAX_%s'%(mx,dmax))
    if dmax and dmax-mx>=2*iv+0.1: flags.append('DEEP_CONTOURS_MISSING max_contour=%s dnr_max=%s'%(mx,dmax))
    if not L.get('max_depth_ft'): flags.append('CARD_MAX_DEPTH_BLANK')
    if any(d% (iv if iv else 1) for d in lv if iv and iv>=1): flags.append('LEVELS_OFF_INTERVAL(iv=%s)'%iv)
    # --- county
    tc=[NORMC(x) for x in tiger.get(lid,[])];r['tiger_county']='/'.join(tc)
    if NORMC(L['county']) not in tc and NORMC(L.get('county2')) not in tc: flags.append('COUNTY_MISMATCH tiger=%s'%'/'.join(tc))
    # --- source label
    vec=meth.get('vector_featureserver',0);pdfn=len(feats)-vec
    src=(L.get('source') or '').lower()
    says_pdf='pdf' in src;says_vec=('indianamap' in src or 'featureserver' in src or 'lake bathymetry' in src) and not says_pdf
    if vec and pdfn: exp='mixed'
    elif vec: exp='vector'
    else: exp='pdf'
    r['source_label']=L.get('source');r['contour_origin']=exp
    if exp=='vector' and says_pdf: flags.append('SOURCE_LABEL_SAYS_PDF_BUT_VECTOR')
    if exp=='pdf' and not says_pdf: flags.append('SOURCE_LABEL_SAYS_VECTOR_BUT_PDF')
    if exp=='mixed': flags.append('MIXED_SOURCES vec=%d pdf=%d'%(vec,pdfn))
    if L.get('pdf_url') and L['pdf_url'] not in pdf_urls: flags.append('PDF_URL_NOT_ON_DNR_PAGE')
    if L.get('georef_method')=='synthetic' or L.get('contour_method')=='synthetic_or_distance_based': flags.append('SYNTHETIC_GEOREF')
    if L.get('depth_assignment')=='distance_from_shore_bins': flags.append('DEPTHS_FROM_DISTANCE_BINS')
    if L.get('needs_review'): flags.append('NEEDS_REVIEW')
    if L.get('exceeds_dnr_max'): flags.append('EXCEEDS_DNR_FLAG')
    r['depth_assignment']=L.get('depth_assignment');r['needs_review']=L.get('needs_review')
    c_=collections.Counter(flags);flags=[k if v==1 else '%s x%d'%(k,v) for k,v in c_.items()]
    r['flags']='; '.join(flags);rows.append(r)
# duplicates: two lakes sharing a shoreline polygon
by=collections.defaultdict(list)
for lid,(b,S) in shoreof.items(): by[b].append(lid)
for b,ls in by.items():
    if len(ls)>1:
        for r in rows:
            if r['lake_id'] in ls: r['flags']=(r['flags']+'; ' if r['flags'] else '')+'SHARES_SHORE_WITH '+','.join(x for x in ls if x!=r['lake_id'])
names=collections.Counter((norm(r['name']),NORMC(r['county'])) for r in rows)
for r in rows:
    if names[(norm(r['name']),NORMC(r['county']))]>1: r['flags']+='; DUP_NAME_COUNTY'
fields=list(dict.fromkeys(k for r in rows for k in r))
w=csv.DictWriter(open(OUT,'w'),fieldnames=fields);w.writeheader();w.writerows(rows)
print('orphans',orphans)
fc=collections.Counter(re.split(r'[ (]',x.strip())[0] for r in rows for x in r['flags'].split(';') if x.strip())
for k,v in fc.most_common(): print(v,k)
