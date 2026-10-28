import json,pickle,math
from shapely.geometry import shape,LineString
from shapely.ops import linemerge
polys={p[0]:p[2] for p in pickle.load(open('/workspace/audit28/polys.pkl','rb'))}
F={f['properties']['objectid']:f for f in json.load(open('../fs_unnamed.geojson'))['features'] if f['geometry']}
U=json.load(open('../unnamed_by_lake.json'))
want={'osm:relation/1921832':'snow','osm:way/30811771':'shriner','osm:relation/3103020':'smalley','nhd:155638503':'marsh','nhd:155639758':'buck','osm:way/1280080356':'fish'}
out={}
for u in U:
    if u['poly_src'] not in want: continue
    P=polys[u['poly_src']];k=111320*math.cos(math.radians(P.centroid.y))
    by={}
    for i in u['ids']:
        f=F[i];d=f['properties']['contour']
        if d is None or d<=0 or d%5: continue
        g=shape(f['geometry'])
        by.setdefault(d,[]).extend(getattr(g,'geoms',[g]))
    feats=[]
    for d,gs in sorted(by.items()):
        m=linemerge(gs);m=getattr(m,'geoms',[m])
        for g in m:
            g=g.simplify(0.000015)
            g2=g.intersection(P.buffer(0.0002))
            for q in getattr(g2,'geoms',[g2]):
                if q.geom_type=='LineString' and q.length*k>=15: feats.append((d,q))
    out[want[u['poly_src']]]=dict(src=u['poly_src'],feats=feats,maxc=max(d for d,_ in feats))
    print(want[u['poly_src']],len(feats),sorted(set(d for d,_ in feats)),sum(len(q.coords) for _,q in feats))
pickle.dump(out,open('fs_batch.pkl','wb'))
