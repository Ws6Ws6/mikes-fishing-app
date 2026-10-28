import numpy as np,cv2,pickle,collections,math
paths=pickle.load(open('paths.pkl','rb'))
w=np.load('water.npy');H,W=w.shape
idm=np.zeros((H,W),np.int32)
for i,p in enumerate(paths): cv2.polylines(idm,[p.astype(np.int32)],False,i+1,5)
seeds=[('NWA',(600,850),30),('NWB',(650,1230),30),('C',(1400,1400),30),('SW',(1225,2278),35),('NE',(2633,1353),55),('SE',(2900,2500),30),('LL',(680,2960),None),('LL5',(640,2700),None),('NE2',(3200,950),40)]
sector={'NE2':(-160,20)}
votes=collections.defaultdict(list)
for name,(sx,sy),D in seeds:
    for a in np.linspace(0,2*math.pi,180,endpoint=False):
        if name in sector:
            deg=math.degrees(math.atan2(math.sin(a),math.cos(a)))
            if not(sector[name][0]<=deg<=sector[name][1]): continue
        dx,dy=math.cos(a),math.sin(a);hits=[];last=0;r=0
        while True:
            x=int(sx+dx*r);y=int(sy+dy*r)
            if not(0<=x<W and 0<=y<H) or w[y,x]==0: break
            v=idm[y,x]
            if v and v!=last and (not hits or hits[-1]!=v): hits.append(v)
            last=v;r+=1
        # hits ordered seed->shore
        n=len(hits)
        for k,h in enumerate(hits):
            from_shore=5*(n-k)
            votes[h-1].append((name,'shore',from_shore))
            if D: votes[h-1].append((name,'seed',D-5*k))
res={}
for i in range(len(paths)):
    V=votes.get(i,[])
    cs=collections.Counter(v for _,t,v in V if t=='shore');cd=collections.Counter(v for _,t,v in V if t=='seed')
    res[i]=(cs.most_common(3),cd.most_common(3))
    print(i,len(paths[i]),res[i])
pickle.dump(votes,open('votes.pkl','wb'))
# rising seeds (humps): k-th hit from top = 5*(k+1), up to nmax hits; priority override
hump={}
for (sx,sy),nmax,R in [((2312,1188),4,140),((815,1040),5,230)]:
    hv=collections.defaultdict(list)
    for a in np.linspace(0,2*math.pi,180,endpoint=False):
        dx,dy=math.cos(a),math.sin(a);hits=[];r=0
        while len(hits)<nmax:
            x=int(sx+dx*r);y=int(sy+dy*r)
            if not(0<=x<W and 0<=y<H) or w[y,x]==0 or r>R: break
            v=idm[y,x]
            if v and (not hits or hits[-1]!=v) and v not in hits: hits.append(v)
            r+=1
        for k,h in enumerate(hits): hv[h-1].append(5*(k+1))
    for i,l in hv.items():
        c=collections.Counter(l).most_common(1)[0]
        if c[1]>=10: hump[i]=c[0]
print('hump',hump)
pickle.dump(hump,open('hump.pkl','wb'))
