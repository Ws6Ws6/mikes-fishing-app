import math,os,urllib.request,numpy as np,cv2
def deg2tile(lat,lon,z):
  n=2**z;x=(lon+180)/360*n;y=(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n;return x,y
def mosaic(lat,lon,z=17,r=4):
  cx,cy=deg2tile(lat,lon,z);tx,ty=int(cx),int(cy)
  os.makedirs('tiles',exist_ok=True)
  rows=[]
  for y in range(ty-r,ty+r+1):
    row=[]
    for x in range(tx-r,tx+r+1):
      fn=f'tiles/{z}_{x}_{y}.jpg'
      if not os.path.exists(fn):
        u=f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        open(fn,'wb').write(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'mfa-retrace'}),timeout=30).read())
      row.append(cv2.imread(fn))
    rows.append(np.hstack(row))
  img=np.vstack(rows)
  # pixel (0,0) of mosaic = tile (tx-r,ty-r); merc meters per pixel
  R=6378137;res=2*math.pi*R/(256*2**z)
  x0=(tx-r)*256*res-math.pi*R;y0=math.pi*R-(ty-r)*256*res
  # merc->px affine
  A=np.array([[1/res,0,-x0/res],[0,-1/res,y0/res]])
  return img,A
def register(pdf_bgr,pdf_mask_exclude,tile_img):
  sift=cv2.SIFT_create(8000)
  g1=cv2.cvtColor(pdf_bgr,cv2.COLOR_BGR2GRAY);g2=cv2.cvtColor(tile_img,cv2.COLOR_BGR2GRAY)
  m1=(~pdf_mask_exclude).astype(np.uint8)*255
  k1,d1=sift.detectAndCompute(g1,m1);k2,d2=sift.detectAndCompute(g2,None)
  bf=cv2.BFMatcher();mm=bf.knnMatch(d1,d2,k=2)
  good=[a for a,b in mm if a.distance<0.75*b.distance]
  p1=np.float32([k1[m.queryIdx].pt for m in good]);p2=np.float32([k2[m.trainIdx].pt for m in good])
  M,inl=cv2.estimateAffinePartial2D(p1,p2,method=cv2.RANSAC,ransacReprojThreshold=4,maxIters=20000)
  return M,int(inl.sum()) if inl is not None else 0,len(good)
