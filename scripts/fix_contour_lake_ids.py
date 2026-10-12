# Audit 2026-10-12 fix: contours keyed only by lake *name*; add lake_id so same-named lakes don't share/merge contours.
import json,collections,shutil
L=json.load(open('data/lakes.geojson'))['features'];D=json.load(open('data/contours.geojson'))
by=collections.defaultdict(list)
for l in L: by[l['properties']['name']].append(l['properties'])
def pts(g): return g['coordinates'] if g['type']=='LineString' else [p for l in g['coordinates'] for p in l]
def score(l,cs):
  x0,y0,x1,y1=l['bbox'];cx,cy=(x0+x1)/2,(y0+y1)/2
  inside=sum(x0-.005<=x<=x1+.005 and y0-.005<=y<=y1+.005 for x,y in cs)
  return (inside,-sum((x-cx)**2+(y-cy)**2 for x,y in cs))
stat=collections.Counter()
for f in D['features']:
  p=f['properties'];c=by.get(p['lake'],[])
  if len(c)==1: p['lake_id']=c[0]['id'];stat['unique']+=1
  elif c: p['lake_id']=max((l for l in c if l.get('bbox')),key=lambda l:score(l,pts(f['geometry'])))['id'];stat['spatial']+=1
  else: stat['unmatched']+=1
json.dump(D,open('data/contours.geojson','w'),separators=(',',':'))
shutil.copy('data/contours.geojson','public/data/contours.geojson')
print(stat)
