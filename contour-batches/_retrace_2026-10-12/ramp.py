import sys,json,cv2,numpy as np
from common import *
def legend(im):
  h,w=im.shape[:2];S=im[:, :int(w*0.07)].astype(int)
  R,G,B=S[...,0],S[...,1],S[...,2]
  green=(G>R+40)&(G>B+30)
  blu=(B>R+25)&(B>90)
  x=int(np.argmax(blu.sum(0)))
  col=blu[:,x];ys=np.nonzero(col)[0];runs=np.split(ys,np.nonzero(np.diff(ys)>4)[0]+1);r=max(runs,key=len)
  # extend up to green LAND box
  gy=np.nonzero(green[:r[0],max(0,x-15):x+15].any(1))[0]
  y0=(gy.max()+2) if len(gy) else r[0];y1=r[-1]
  xs=slice(max(0,x-6),x+7)
  cols=np.array([np.median(im[y,xs].reshape(-1,3),0) for y in range(y0,y1+1)])
  # drop dark separator rows
  keep=cols.sum(1)>cols.sum(1).max()*0.25 if False else np.ones(len(cols),bool)
  return x,y0,y1,cols
def run(lid,name,top_ft,max_ft,interval,P,out_prefix):
  im=cv2.cvtColor(cv2.imread(f'r/{lid}.png'),cv2.COLOR_BGR2RGB);h,w=im.shape[:2]
  x,y0,y1,cols=legend(im)
  # remove separator lines in legend (dark) by filtering rows darker than neighbors
  lum=cols.mean(1);good=lum>=np.convolve(lum,np.ones(9)/9,'same')-12
  t=np.linspace(0,1,len(cols));depths=top_ft+(max_ft-top_ft)*t
  cols,depths=cols[good],depths[good]
  lab=cv2.cvtColor(im,cv2.COLOR_RGB2LAB).astype(np.float32)
  clab=cv2.cvtColor(cols.astype(np.uint8)[None],cv2.COLOR_RGB2LAB)[0].astype(np.float32)
  hsv=cv2.cvtColor(im,cv2.COLOR_RGB2HSV)
  water=((hsv[...,0]>=78)&(hsv[...,0]<=140)&(hsv[...,1]>=25)&(hsv[...,2]>=60))
  water[:, :x+40]=False  # exclude legend strip
  hb=int(h*0.2) if h>w else int(h*0.25);water[:hb,int(w*0.62):]=False
  dark=(im.astype(int).sum(2)<200)
  wm=cv2.morphologyEx(water.astype(np.uint8),cv2.MORPH_CLOSE,np.ones((7,7),np.uint8))
  wm=largest_cc(cv2.morphologyEx(wm,cv2.MORPH_OPEN,np.ones((7,7),np.uint8)),0.1)
  wm=cv2.morphologyEx(wm.astype(np.uint8),cv2.MORPH_CLOSE,np.ones((15,15),np.uint8)).astype(bool)
  # fill holes that are dark lines/labels: inpaint non-water pixels inside lake
  bad=((~water)|dark)&wm
  bad=cv2.dilate(bad.astype(np.uint8),np.ones((3,3),np.uint8))
  imc=cv2.inpaint(cv2.cvtColor(im,cv2.COLOR_RGB2BGR),bad,5,cv2.INPAINT_TELEA)
  labc=cv2.cvtColor(imc,cv2.COLOR_BGR2LAB).astype(np.float32)
  ys,xs=np.nonzero(wm);v=labc[ys,xs]
  from scipy.spatial import cKDTree
  dd,idx=cKDTree(clab).query(v,workers=-1)
  D=np.zeros((h,w),np.float32);D[ys,xs]=depths[idx]
  # shore=0 outside
  D=cv2.GaussianBlur(D,(0,0),4);Wb=cv2.GaussianBlur(wm.astype(np.float32),(0,0),4);D=np.where(wm,D/np.maximum(Wb,1e-3),0)
  dlp=dark&wm
  ys2,xs2=np.nonzero(cv2.erode(wm.astype(np.uint8),np.ones((15,15),np.uint8)).astype(bool)&dlp)
  vals=D[ys2,xs2]
  hist=np.histogram(vals,bins=np.arange(0,max_ft+2,1))[0]
  np.save(out_prefix+'_linehist.npy',hist)
  fine=np.histogram(vals,bins=np.arange(0,max_ft+2,0.5))[0].astype(float);cen=np.arange(0,max_ft+1.5,0.5)+0.25
  from scipy.signal import find_peaks
  pk,_=find_peaks(np.convolve(fine,[1,2,1],'same'),prominence=fine.max()*0.03)
  pv=cen[pk];pw=fine[pk];fmax=float(D[wm].max())
  best=None
  for a in np.arange(0.8,1.35,0.005):
    for b in np.arange(-12,12,0.1):
      m=a*pv+b;r=np.abs(m-np.round(m/interval)*interval)
      sc=(pw*r).sum()/pw.sum()+0.3*abs(a*fmax+b-max_ft)
      if best is None or sc<best[0]: best=(sc,a,b,(pw*r).sum()/pw.sum())
  _,ca,cb,resid=best
  D=np.where(wm,np.clip(ca*D+cb,0,max_ft),0).astype(np.float32)
  calib=dict(a=round(float(ca),3),b=round(float(cb),2),peak_resid_ft=round(float(resid),2),n_peaks=int(len(pv)),peaks=[round(float(x),1) for x in pv])
  A,iou=georef_search(wm,P)
  levels=list(range(interval,int(max_ft)+1,interval))
  feats=lines_from_field(D,wm,levels,A,P)
  dmax=float(D[wm].max())
  # QA: distance from my isolines (px) to drawn dark lines
  from scipy.ndimage import distance_transform_edt
  dl=dark&wm;dt=distance_transform_edt(~dl)
  Ai=A
  ds=[]
  for lv,ls in feats:
    for X,Y in list(ls.coords)[::3]:
      px=Ai[0,0]*X+Ai[0,1]*Y+Ai[0,2];py=Ai[1,0]*X+Ai[1,1]*Y+Ai[1,2]
      if 0<=int(py)<h and 0<=int(px)<w: ds.append(dt[int(py),int(px)])
  ds=np.array(ds)
  # overlay image
  ov=im.copy()
  for lv,ls in feats:
    pts=np.array([[Ai[0,0]*X+Ai[0,1]*Y+Ai[0,2],Ai[1,0]*X+Ai[1,1]*Y+Ai[1,2]] for X,Y in ls.coords],np.int32)
    cv2.polylines(ov,[pts],False,(255,0,0),2)
    if len(pts)>40:
      m=pts[len(pts)//2];cv2.putText(ov,str(lv),(int(m[0])+3,int(m[1])-3),cv2.FONT_HERSHEY_SIMPLEX,0.8,(255,0,0),2)
  r=raster_poly(P,A,(h,w));cs,_=cv2.findContours(r,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE);cv2.drawContours(ov,cs,-1,(255,140,0),3)
  cv2.imwrite(out_prefix+'_overlay.png',cv2.cvtColor(ov,cv2.COLOR_RGB2BGR))
  q=dict(calib=calib,lid=lid,georef_iou=round(float(iou),3),field_max=round(dmax,1),pdf_max=max_ft,n_lines=len(feats),levels=sorted({lv for lv,_ in feats}),line_to_drawn_px_median=round(float(np.median(ds)),1) if len(ds) else None,p90=round(float(np.percentile(ds,90)),1) if len(ds) else None,px_per_m=round(float(np.hypot(A[0,0],A[1,0])),3))
  write_features(lid,name,feats,P,'pdf_color_ramp_isolines',out_prefix+'.geojson')
  return q
