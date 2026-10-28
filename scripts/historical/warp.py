import numpy as np,json,math,cv2,sys,importlib
from scipy.interpolate import RBFInterpolator
from shapely.geometry import shape
import matplotlib;matplotlib.use('Agg');import matplotlib.pyplot as plt
import anchors;importlib.reload(anchors)
M=np.array([a for a,b in anchors.A],float);R=np.array([b for a,b in anchors.A],float)
f=RBFInterpolator(M,R,kernel='thin_plate_spline',smoothing=float(sys.argv[1]) if len(sys.argv)>1 else 0)
w=np.load('water.npy')
cs,_=cv2.findContours(w,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_NONE)
P=shape(json.load(open('/workspace/jim/jimmerson_osm.json')))
lat0,lon0=41.71,-85.065;k=111320*math.cos(math.radians(lat0))
fig,ax=plt.subplots(figsize=(11,13))
for g in getattr(P,'geoms',[P]):
    for r in [g.exterior,*g.interiors]:
        x,y=np.array(r.coords).T;ax.plot((x-lon0)*k,(y-lat0)*110574,'b-',lw=1)
for c in cs:
    if len(c)<50: continue
    Y=f(c[::5,0,:].astype(float));ax.plot(Y[:,0],Y[:,1],'r-',lw=1)
ax.plot(R[:,0],R[:,1],'go',ms=4)
for i,(x,y) in enumerate(R): ax.text(x,y,str(i),fontsize=7)
ax.set_xticks(range(-1500,1600,100));ax.set_yticks(range(-1700,1800,100));ax.tick_params(labelsize=6);ax.grid(lw=0.4);ax.set_aspect(1)
ax.set_xlim(-800,1500);ax.set_ylim(-1700,500)
plt.savefig(sys.argv[2] if len(sys.argv)>2 else 'warp.png',dpi=75,bbox_inches='tight')
