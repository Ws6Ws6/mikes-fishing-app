import fitz,re,json,numpy as np,cv2
from shapely.geometry import LineString,Polygon,Point,MultiLineString
from shapely.ops import linemerge,unary_union,polygonize
from common import *
YEL=(1.0,1.0,0.0)
def paths(page,color,minw=0,maxw=99):
  out=[]
  for g in page.get_drawings():
    c=g.get('color');
    if not c or tuple(round(x,2) for x in c)!=color: continue
    w=g.get('width') or 0
    if not(minw<=w<=maxw): continue
    cur=[]
    for it in g['items']:
      if it[0]=='l': a,b=it[1],it[2]
      elif it[0]=='c': a,b=it[1],it[4]
      elif it[0]=='re':
        continue
      else: continue
      if cur and (abs(cur[-1][0]-a.x)>0.01 or abs(cur[-1][1]-a.y)>0.01):
        if len(cur)>1: out.append(cur)
        cur=[]
      if not cur: cur=[(a.x,a.y)]
      if it[0]=='c':
        p0,p1,p2,p3=it[1],it[2],it[3],it[4]
        for t in (0.25,0.5,0.75):
          mt=1-t;cur.append((mt**3*p0.x+3*mt*mt*t*p1.x+3*mt*t*t*p2.x+t**3*p3.x,mt**3*p0.y+3*mt*mt*t*p1.y+3*mt*t*t*p2.y+t**3*p3.y))
      cur.append((b.x,b.y))
    if len(cur)>1: out.append(cur)
  return out
def labels(page,clip=None):
  L=[]
  for w in page.get_text('words'):
    t=w[4].replace("'",'').replace('’','')
    if re.fullmatch(r"[0-9]+",t):
      cx,cy=(w[0]+w[2])/2,(w[1]+w[3])/2
      if clip and not clip.contains(Point(cx,cy)): continue
      L.append((int(t),cx,cy,"'" in w[4] or '’' in w[4]))
  return L

def shore_mask(page,S,scale=2.0,raster_fallback=None):
  W,H=int(page.rect.width*scale),int(page.rect.height*scale)
  m=np.zeros((H,W),np.uint8)
  for p in S: cv2.polylines(m,[np.int32(np.array(p)*scale)],False,1,3)
  # fill enclosed areas: flood from border
  ff=m.copy();cv2.floodFill(ff,None,(0,0),2)
  water=(ff==0)|(m==1)
  return largest_cc(water.astype(np.uint8),0.05).astype(bool)
def assign(Y,lab,interval,maxd,tol=6.0):
  rings=[];opens=[]
  # merge broken segments (snap endpoints)
  cl=[p for p in Y if len(p)>3 and np.hypot(p[0][0]-p[-1][0],p[0][1]-p[-1][1])<0.5]
  op=[p for p in Y if not(len(p)>3 and np.hypot(p[0][0]-p[-1][0],p[0][1]-p[-1][1])<0.5)]
  if op:
    q=lambda c:(round(c[0]*4)/4,round(c[1]*4)/4)
    mg=linemerge([LineString([q(c) for c in p]) for p in op if len(p)>1])
    mg=[mg] if mg.geom_type=='LineString' else list(mg.geoms)
    op=[list(g.coords) for g in mg]
  Y=cl+op
  for p in Y:
    ls=LineString(p)
    if ls.length<3: continue
    if np.hypot(p[0][0]-p[-1][0],p[0][1]-p[-1][1])<0.5 and len(p)>3:
      pg=Polygon(p).buffer(0)
      if pg.area>0: rings.append(dict(ls=ls,pg=pg))
    else: opens.append(dict(ls=ls))
  allL=rings+opens
  for r in allL: r['labs']=[]
  for v,x,y,m in lab:
    if m: continue
    ds=[(r['ls'].distance(Point(x,y)),i) for i,r in enumerate(allL)]
    d,i=min(ds)
    if d<tol: allL[i]['labs'].append(v)
  for r in allL:
    n=r['labs'];r['label']=max(set(n),key=n.count) if n else None
  rings.sort(key=lambda r:-r['pg'].area)
  for i,r in enumerate(rings):
    par=[q for q in rings[:i] if q['pg'].area>r['pg'].area and q['pg'].contains(r['pg'].representative_point())]
    r['parent']=min(par,key=lambda q:q['pg'].area) if par else None
  for r in rings: r['kids']=[q for q in rings if q.get('parent') is r]
  def down(r,k=1):
    out=[]
    for c in r['kids']:
      if c['label'] is not None: out.append(c['label']-k*interval)
      else: out+=down(c,k+1)
    return out
  def up(r):
    k=1;p=r['parent']
    while p is not None:
      if p['label'] is not None: return [p['label']+k*interval]
      k+=1;p=p['parent']
    return [k*interval]  # root = shore depth 0
  agree=dis=conflict=0
  for r in rings:
    if r['label'] is not None:
      r['depth']=r['label'];r['src']='label'
      p=r['parent']
      if p is not None and p['label'] is not None:
        if abs(p['label']-r['label'])==interval: agree+=1
        else: dis+=1
      continue
    d=down(r);u=up(r)
    if d:
      vals=sorted(set(d))
      if len(vals)>1: conflict+=1
      r['depth']=max(set(d),key=d.count);r['src']='from_child_label'
    else: r['depth']=u[0];r['src']='from_parent'
  for o in opens:
    if o['label'] is not None: o['depth']=o['label'];o['src']='label'
    else:
      # depth from smallest ring containing its midpoint +interval
      mp=o['ls'].interpolate(0.5,normalized=True)
      par=[q for q in rings if q['pg'].contains(mp)]
      o['depth']=(min(par,key=lambda q:q['pg'].area)['depth']+interval) if par else None
      o['src']='nesting_open'
  return allL,dict(rings=len(rings),open=len(opens),labeled=sum(r['label'] is not None for r in allL),parent_child_label_agree=agree,parent_child_label_disagree=dis,child_conflicts=conflict,unassigned=sum(r.get('depth') is None for r in allL),over_max=sum((r.get('depth') or 0)>maxd for r in allL))
def process(lid,name,interval,maxd,P,shore_color=(0.0,0.47,0.9),out='out',water_override=None,frame_bottom=0.8,keep_frac=0.05,water_from_yellow=False,label_maxlen=None,clipP=None):
  pg=fitz.open(f'pdf/{lid}.pdf')[0];sc=2.0
  Y=paths(pg,YEL);S=paths(pg,shore_color,3,5);lab=labels(pg)
  if water_override is not None: water=water_override
  elif water_from_yellow:
    m=np.zeros((int(pg.rect.height*sc),int(pg.rect.width*sc)),np.uint8)
    for p in paths(pg,YEL):
      if len(p)>3 and np.hypot(p[0][0]-p[-1][0],p[0][1]-p[-1][1])<0.5: cv2.fillPoly(m,[np.int32(np.array(p)*sc)],1)
    water=largest_cc(m,0.05).astype(bool)
  else:
    pix=pg.get_pixmap(matrix=fitz.Matrix(sc,sc));im=np.frombuffer(pix.samples,np.uint8).reshape(pix.h,pix.w,pix.n)[...,:3].copy()
    hsv=cv2.cvtColor(im,cv2.COLOR_RGB2HSV)
    w=((hsv[...,0]>=85)&(hsv[...,0]<=130)&(hsv[...,1]>=40)&(hsv[...,2]>=40))|((hsv[...,0]>=20)&(hsv[...,0]<=40)&(hsv[...,1]>=120)&(hsv[...,2]>=150))
    w[int(pix.h*frame_bottom):]=False
    w=cv2.morphologyEx(w.astype(np.uint8),cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
    w=cv2.morphologyEx(w,cv2.MORPH_OPEN,np.ones((5,5),np.uint8))
    water=largest_cc(w,keep_frac).astype(bool)
    cv2.imwrite(f'{out}/{lid}_water.png',water.astype(np.uint8)*255)
  sb=scalebar_pt_per_mile(pg)
  txt=pg.get_text()
  mR=re.search(r'1\s*:\s*([0-9][0-9,]{2,})',txt)
  if mR and not (sb and sb[1]<3):
    N=float(mR.group(1).replace(',',''));sb=(72/0.0254/N*1609.344,0.0,'ratio 1:%d'%N)
  if sb and sb[1]<3:
    lat=math.degrees(2*math.atan(math.exp(P.centroid.y/6378137))-math.pi/2)
    s_=sc*sb[0]/1609.344*math.cos(math.radians(lat))
    A,iou=georef_scaled(water,P,s_);gm='scalebar+translation'
  else:
    A,iou=georef(water,P);gm='ecc_affine'
  allL,stats=assign(Y,lab,interval,maxd)
  f=px_to_merc_fn(A);feats=[]
  for r in allL:
    if r.get('depth') is None or r['depth']<=0 or r['depth']>maxd: continue
    ls=LineString([f(x*sc,y*sc) for x,y in r['ls'].coords]).simplify(0.8)
    g=ls.intersection((clipP if clipP is not None else P).buffer(2))
    for part in ([g] if g.geom_type=='LineString' else getattr(g,'geoms',[])):
      if part.geom_type=='LineString' and part.length>15: feats.append((r['depth'],part))
  # overlay on 200dpi render
  im=cv2.imread(f'r/{lid}.png');k=200/72/sc
  for d,ls in feats:
    pts=[]
    for X,Y_ in ls.coords:
      px=A[0,0]*X+A[0,1]*Y_+A[0,2];py=A[1,0]*X+A[1,1]*Y_+A[1,2];pts.append((px*k,py*k))
    pts=np.int32(pts);cv2.polylines(im,[pts],False,(0,0,255),2)
    m=pts[len(pts)//2];cv2.putText(im,str(d),(int(m[0])+4,int(m[1])+14),cv2.FONT_HERSHEY_SIMPLEX,0.7,(0,0,255),2)
  r=raster_poly(P,A*k,im.shape[:2]);cs,_=cv2.findContours(r,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE);cv2.drawContours(im,cs,-1,(0,140,255),2)
  cv2.imwrite(f'{out}/{lid}_overlay.png',im)
  write_features(lid,name,feats,clipP if clipP is not None else P,'pdf_vector_label_nesting',f'{out}/{lid}.geojson')
  stats.update(georef=gm,scalebar=sb,lid=lid,georef_iou=round(float(iou),3),n_out=len(feats),levels=sorted({d for d,_ in feats}),max_line=max([d for d,_ in feats] or [0]),pdf_max=maxd)
  return stats

def scalebar_pt_per_mile(page):
  W=page.get_text('words')
  mi=[w for w in W if w[4].lower().startswith('mile')]
  if not mi: return None
  my=(mi[0][1]+mi[0][3])/2
  nums=[w for w in W if re.fullmatch(r'0|[0-9]*\.[0-9]+|[0-9]',w[4]) and abs((w[1]+w[3])/2-my)<20 and mi[0][0]-380<w[0]<mi[0][0]+5]
  if len(nums)<3:
    my2=[w for w in W if re.fullmatch(r'[0-9]*\.?[0-9]+',w[4])]
    return None
  xs=np.array([(w[0]+w[2])/2 for w in nums]);vs=np.array([float(w[4]) for w in nums])
  # use the row that contains 0
  a,b=np.polyfit(vs,xs,1);res=np.abs(np.polyval([a,b],vs)-xs).max()
  return a,res,len(nums)
def georef_scaled(water,P,s):
  """merc->px with fixed scale s (px per merc m), north-up; translation by template matching."""
  bx0,by0,bx1,by1=P.bounds;pad=0
  A0=np.array([[s,0,-s*bx0],[0,-s,s*by1]])
  Wp,Hp=int((bx1-bx0)*s)+1,int((by1-by0)*s)+1
  osm=raster_poly(P,A0,(Hp,Wp)).astype(np.float32)
  H,W=water.shape;big=np.zeros((H+2*Hp,W+2*Wp),np.float32);big[Hp:Hp+H,Wp:Wp+W]=water
  # downscale for speed
  f=0.5;bs=cv2.resize(big,None,fx=f,fy=f);os_=cv2.resize(osm,None,fx=f,fy=f)
  # score = overlap - 0.5*mismatch  => use 2*ccorr on +/-1 images
  b2=bs*2-1;o2=os_*2-1
  r=cv2.matchTemplate(b2,o2,cv2.TM_CCORR)
  _,_,_,loc=cv2.minMaxLoc(r)
  tx,ty=loc[0]/f-Wp,loc[1]/f-Hp
  A=A0.copy();A[0,2]+=tx;A[1,2]+=ty
  # local refine +-6 px
  best=None
  for dx in range(-6,7,2):
    for dy in range(-6,7,2):
      A2=A.copy();A2[0,2]+=dx;A2[1,2]+=dy;rr=raster_poly(P,A2,water.shape).astype(bool)
      iou=(rr&water).sum()/max(1,(rr|water).sum())
      if best is None or iou>best[0]: best=(iou,A2)
  return best[1],best[0]
