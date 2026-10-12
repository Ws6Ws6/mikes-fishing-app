import sys,json,time
from vector import *
OSMQ={'hackenburg-lake':'Hackenburg Lake, LaGrange County, Indiana','lake-of-the-woods-steuben':'Lake of the Woods, Timberhurst, Indiana','round-lake-noble':'Round Lake, Noble County, Indiana','messick-lake':'Messick Lake, Indiana'}
CFG={'webster-lake-kosciusko':('Webster Lake',5,45),'hackenburg-lake':('Hackenburg Lake',5,39),'lake-of-the-woods-steuben':('Lake of the Woods',10,84),'round-lake-noble':('Round Lake',5,64),'waldron-lake-noble':('Waldron Lake',5,46),'sylvan-lake-east-west-noble':('Sylvan Lake',5,25),'messick-lake':('Messick Lake',10,56)}
KW={'waldron-lake-noble':dict(water_from_yellow=True)}
def getP(lid):
  if lid=='messick-lake': return nominatim_poly(OSMQ[lid])[0][3]
  try: return osm_poly(lid)
  except Exception:
    time.sleep(1.1);c=nominatim_poly(OSMQ[lid]);return c[0][3]
for lid in sys.argv[1:]:
  n,iv,mx=CFG[lid];kw=KW.get(lid,{});print(json.dumps(process(lid,n,iv,mx,getP(lid),**kw)))
