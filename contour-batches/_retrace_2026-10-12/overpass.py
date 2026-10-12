import json,urllib.request,urllib.parse,sys
from shapely.geometry import Polygon,MultiPolygon
from shapely.ops import unary_union,polygonize,linemerge
from common import *
def water_near(lat,lon,r=1500):
  q=f'[out:json][timeout:60];(way(around:{r},{lat},{lon})[natural=water];relation(around:{r},{lat},{lon})[natural=water];way(around:{r},{lat},{lon})[water];);out geom;'
  for ep in ['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter']:
    try:
      d=json.load(urllib.request.urlopen(urllib.request.Request(ep,data=urllib.parse.urlencode({'data':q}).encode(),headers={'User-Agent':'mfa-retrace'}),timeout=90));break
    except Exception as e: print('ep fail',e,file=sys.stderr)
  out=[]
  for e in d['elements']:
    name=e.get('tags',{}).get('name')
    if e['type']=='way' and 'geometry' in e and len(e['geometry'])>3:
      p=Polygon([(g['lon'],g['lat']) for g in e['geometry']]).buffer(0)
    elif e['type']=='relation':
      ls=[LineString([(g['lon'],g['lat']) for g in m['geometry']]) for m in e['members'] if m.get('role')=='outer' and 'geometry' in m]
      inn=[LineString([(g['lon'],g['lat']) for g in m['geometry']]) for m in e['members'] if m.get('role')=='inner' and 'geometry' in m]
      p=unary_union(list(polygonize(linemerge(ls)))) if ls else None
      if p is not None and inn: p=p.difference(unary_union(list(polygonize(linemerge(inn)))))
    else: continue
    if p is None or p.is_empty: continue
    out.append((e['type'],e['id'],name,T(lambda x,y,z=None:W2M.transform(x,y),p)))
  return out
