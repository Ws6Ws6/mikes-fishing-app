import numpy as np,pickle,json,math,importlib
from scipy.interpolate import RBFInterpolator
from shapely.geometry import shape,LineString,MultiLineString,mapping
import anchors
paths=pickle.load(open('paths.pkl','rb'));D=pickle.load(open('D.pkl','rb'))
M=np.array([a for a,b in anchors.A],float);R=np.array([b for a,b in anchors.A],float)
f=RBFInterpolator(M,R,kernel='thin_plate_spline')
lat0,lon0=41.71,-85.065;k=111320*math.cos(math.radians(lat0))
P=shape(json.load(open('/workspace/jim/jimmerson_osm.json')))
feats=[]
for i,p in enumerate(paths):
    d=D.get(i)
    if not d: continue
    Y=f(p[::3].astype(float))
    ll=np.c_[Y[:,0]/k+lon0,Y[:,1]/110574+lat0]
    g=LineString(ll).simplify(0.00001)
    g=g.intersection(P)
    if g.is_empty: continue
    parts=[g] if g.geom_type=='LineString' else [x for x in getattr(g,'geoms',[]) if x.geom_type=='LineString']
    for q in parts:
        if q.length*k<25: continue
        feats.append((d,q))
pickle.dump(feats,open('feats.pkl','wb'))
print(len(feats),sorted(set(d for d,_ in feats)))
