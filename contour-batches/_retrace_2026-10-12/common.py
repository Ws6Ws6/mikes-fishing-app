import json,math,cv2,numpy as np
from shapely.geometry import shape,Polygon,MultiPolygon,LineString,MultiLineString,mapping
from shapely.ops import transform as T, unary_union
from pyproj import Transformer
W2M=Transformer.from_crs(4326,3857,always_xy=True);M2W=Transformer.from_crs(3857,4326,always_xy=True)
OSM='/workspace/mikes-fishing-app/contour-batches/_shoreline_pass_v2/osm/'
def osm_poly(lid):
  g=json.load(open(OSM+lid+'.geojson'));g=g.get('geometry',g)
  return T(lambda x,y,z=None:W2M.transform(x,y),shape(g))
def nominatim_poly(q):
  import urllib.request,urllib.parse
  u='https://nominatim.openstreetmap.org/search?'+urllib.parse.urlencode(dict(q=q,format='json',polygon_geojson=1,limit=5))
  h=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'mfa-retrace'})))
  h=[x for x in h if x['geojson']['type'] in('Polygon','MultiPolygon')]
  return [(x['display_name'],x['osm_type'],x['osm_id'],T(lambda a,b,z=None:W2M.transform(a,b),shape(x['geojson']))) for x in h]
def largest_cc(mask,keep_frac=0.0):
  n,l,s,_=cv2.connectedComponentsWithStats(mask.astype(np.uint8),8)
  if n<=1: return mask
  i=1+np.argmax(s[1:,4]);out=(l==i)
  if keep_frac:
    for j in range(1,n):
      if s[j,4]>=s[i,4]*keep_frac: out|=(l==j)
  return out
def raster_poly(P,A,shape_):
  # A maps merc->px (2x3)
  img=np.zeros(shape_,np.uint8)
  polys=[P] if P.geom_type=='Polygon' else list(P.geoms)
  for p in polys:
    ext=np.array([[A[0,0]*x+A[0,1]*y+A[0,2],A[1,0]*x+A[1,1]*y+A[1,2]] for x,y in p.exterior.coords],np.int32)
    cv2.fillPoly(img,[ext],1)
    for h in p.interiors:
      cv2.fillPoly(img,[np.array([[A[0,0]*x+A[0,1]*y+A[0,2],A[1,0]*x+A[1,1]*y+A[1,2]] for x,y in h.coords],np.int32)],0)
  return img
def georef(mask,P,allow_rot=True):
  """Fit merc->px affine so OSM polygon P matches pdf water mask. returns A(merc->px), iou"""
  ys,xs=np.nonzero(mask);x0,x1,y0,y1=xs.min(),xs.max(),ys.min(),ys.max()
  bx0,by0,bx1,by1=P.bounds
  s=min((x1-x0)/(bx1-bx0),(y1-y0)/(by1-by0))
  A=np.array([[s,0,x0-s*bx0],[0,-s,y0+s*by1]],np.float64)
  # ECC on blurred masks at reduced scale
  f=0.25;sm=(int(mask.shape[0]*f),int(mask.shape[1]*f))
  a=cv2.GaussianBlur(cv2.resize(mask.astype(np.float32),(sm[1],sm[0])),(0,0),3)
  best=(0,A)
  for mode in ([cv2.MOTION_AFFINE] if allow_rot else [cv2.MOTION_AFFINE]):
    Af=A.copy();Af[:, :]*=f
    b=cv2.GaussianBlur(raster_poly(P,Af,sm).astype(np.float32),(0,0),3)
    warp=np.eye(2,3,dtype=np.float32)
    try:
      _,warp=cv2.findTransformECC(a,b,warp,mode,(cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT,500,1e-6),None,5)
    except cv2.error as e: print('ecc fail',e)
    # b(x)=a(warp x) -> osm raster px p maps to pdf px warp*p
    W3=np.vstack([warp,[0,0,1]]);Af3=np.vstack([Af,[0,0,1]])
    A2=(W3@Af3)[:2];A2=A2/f
    r=raster_poly(P,A2,mask.shape).astype(bool)
    iou=(r&mask).sum()/max(1,(r|mask).sum())
    if iou>best[0]: best=(iou,A2)
  return best[1],best[0]
def px_to_merc_fn(A):
  A3=np.linalg.inv(np.vstack([A,[0,0,1]]))
  return lambda x,y,z=None:(A3[0,0]*x+A3[0,1]*y+A3[0,2],A3[1,0]*x+A3[1,1]*y+A3[1,2])
def to_wgs(g): return T(lambda x,y,z=None:M2W.transform(x,y),g)
def lines_from_field(D,valid,levels,A,P,min_len_m=40,simplify_m=1.5,shore_noise_m=10):
  from skimage.measure import find_contours
  Dm=np.where(valid,D,-1.0);f=px_to_merc_fn(A);feats=[]
  Pin=P.buffer(0)
  for lv in levels:
    for c in find_contours(Dm,lv):
      ls=LineString([f(x,y) for y,x in c])
      if ls.length<min_len_m: continue
      g=ls.intersection(Pin).simplify(simplify_m)
      for part in ([g] if g.geom_type=='LineString' else getattr(g,'geoms',[])):
        if part.geom_type=='LineString' and part.length>=min_len_m:
          bd=Pin.boundary;pts=[part.interpolate(t,normalized=True) for t in np.linspace(0,1,12)]
          if np.mean([bd.distance(p) for p in pts])<shore_noise_m: continue
          feats.append((lv,part))
  return feats
def write_features(lid,name,feats,P,method,out):
  F=[]
  shore=[P.exterior] if P.geom_type=='Polygon' else [p.exterior for p in P.geoms]
  shore+= [i for p in ([P] if P.geom_type=='Polygon' else P.geoms) for i in p.interiors]
  for r in shore:
    F.append(dict(type='Feature',geometry=mapping(to_wgs(LineString(r.coords).simplify(1.0))),properties=dict(lake=name,lake_id=lid,depth_ft=0,line_type='SHORELINE',contour_method='traced_from_pdf',line_style='solid',georef_method='osm_ecc_affine',depth_assignment='shoreline')))
  for lv,ls in feats:
    F.append(dict(type='Feature',geometry=mapping(to_wgs(ls)),properties=dict(lake=name,lake_id=lid,depth_ft=int(lv),line_type='INDEX' if lv%10==0 else 'INTERMEDIATE',contour_method='traced_from_pdf',line_style='solid',georef_method='osm_ecc_affine',depth_assignment=method)))
  json.dump(dict(type='FeatureCollection',features=F),open(out,'w'))
  return F

def georef_search(water,P):
  import vector
  ys,xs=np.nonzero(water);bx0,by0,bx1,by1=P.bounds
  s0=np.sqrt(water.sum()/ (P.area))  # px per merc m by area
  best=(0,None)
  for k in np.linspace(0.85,1.15,13):
    A,iou=vector.georef_scaled(water,P,s0*k)
    if iou>best[0]: best=(iou,A)
  return best[1],best[0]
