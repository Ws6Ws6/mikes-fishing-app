import numpy as np,cv2,pickle,collections,json
paths=pickle.load(open('paths.pkl','rb'));votes=pickle.load(open('votes.pkl','rb'))
over=json.load(open('override.json')) if __import__('os').path.exists('override.json') else {}
hump=pickle.load(open('hump.pkl','rb'))
for k,v in hump.items(): over.setdefault(str(k),v)
D={}
for i in range(len(paths)):
    if str(i) in over: D[i]=over[str(i)];continue
    V=votes.get(i,[])
    cd=collections.Counter(v for _,t,v in V if t=='seed' and v>0)
    cs=collections.Counter(v for _,t,v in V if t=='shore')
    D[i]=cd.most_common(1)[0][0] if cd else (cs.most_common(1)[0][0] if cs else None)
pickle.dump(D,open('D.pkl','wb'))
m=cv2.imread('/workspace/missing/old/jimerson_6019.jpg')
cols={5:(255,255,0),10:(0,255,0),15:(0,255,255),20:(0,128,255),25:(0,0,255),30:(255,0,255),35:(255,0,128),40:(128,0,255),45:(255,128,128),50:(128,255,128),55:(255,255,255)}
v=(m*0.7).astype(np.uint8)
for i,p in enumerate(paths):
    c=cols.get(D[i],(128,128,128));cv2.polylines(v,[p.astype(np.int32)],False,c,3)
for i,p in enumerate(paths):
    q=p[len(p)//2].astype(int);cv2.putText(v,f'{i}:{D[i]}',tuple(q+[6,-6]),0,0.7,(255,255,255),3);cv2.putText(v,f'{i}:{D[i]}',tuple(q+[6,-6]),0,0.7,(0,0,0),1)
def grid(x0,y0,x1,y1,name,W=800):
    c=v[y0:y1,x0:x1];s=W/max(c.shape[:2]);cv2.imwrite(name,cv2.resize(c,None,fx=s,fy=s,interpolation=cv2.INTER_AREA))
import sys;S=sys.argv[1];grid(150,350,1500,1700,f'd_nw{S}.png');grid(1100,850,2450,2200,f'd_c{S}.png');grid(400,1800,1600,3300,f'd_sw{S}.png');grid(2200,250,3800,1900,f'd_ne{S}.png');grid(2500,1700,3600,2900,f'd_se{S}.png')
