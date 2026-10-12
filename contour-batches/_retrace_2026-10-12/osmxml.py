import xml.etree.ElementTree as ET,sys
from shapely.geometry import Polygon,LineString
from shapely.ops import polygonize,linemerge,unary_union
from common import *
def water_polys(fn):
  r=ET.parse(fn).getroot()
  N={n.get('id'):(float(n.get('lon')),float(n.get('lat'))) for n in r.iter('node')}
  Wy={};out=[]
  for w in r.iter('way'):
    pts=[N[n.get('ref')] for n in w.iter('nd') if n.get('ref') in N];Wy[w.get('id')]=pts
    t={x.get('k'):x.get('v') for x in w.iter('tag')}
    if (t.get('natural')=='water' or 'water' in t) and len(pts)>3 and pts[0]==pts[-1]:
      out.append(('way',w.get('id'),t.get('name'),Polygon(pts).buffer(0)))
  for rel in r.iter('relation'):
    t={x.get('k'):x.get('v') for x in rel.iter('tag')}
    if t.get('natural')!='water': continue
    outer=[LineString(Wy[m.get('ref')]) for m in rel.iter('member') if m.get('type')=='way' and m.get('role')=='outer' and len(Wy.get(m.get('ref'),[]))>1]
    inner=[LineString(Wy[m.get('ref')]) for m in rel.iter('member') if m.get('type')=='way' and m.get('role')=='inner' and len(Wy.get(m.get('ref'),[]))>1]
    p=unary_union(list(polygonize(linemerge(outer)))) if outer else None
    if p is not None and not p.is_empty:
      if inner: p=p.difference(unary_union(list(polygonize(linemerge(inner)))))
      out.append(('relation',rel.get('id'),t.get('name'),p))
  return [(a,b,c,T(lambda x,y,z=None:W2M.transform(x,y),p)) for a,b,c,p in out]
if __name__=='__main__':
  for a,b,c,p in water_polys(sys.argv[1]): print(a,b,c,round(p.area),[round(v,4) for v in to_wgs(p.centroid).coords[0]])
