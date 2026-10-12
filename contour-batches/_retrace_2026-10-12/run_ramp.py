import sys,json
from ramp import run
from common import *
from osmxml import water_polys
CFG={'round-lake-steuben':('Round Lake',2,62,5,'osm/way_1165516536.xml'),
     'dillards-pit':('Dillard\'s Pit',1,49,5,'osm/way_145076913.xml'),
     'indian-lake-dekalb':('Indian Lake',1,50,5,None),
     'little-cedar-lake-whitley':('Little Cedar Lake',1,59,5,None),
     'loon-lake-noble':('Loon Lake',2,94,10,'osm/way_31012503.xml')}
for lid in sys.argv[1:]:
  n,top,mx,iv,src=CFG[lid]
  P=water_polys(src)[0][3] if src else osm_poly(lid)
  print(json.dumps(run(lid,n,top,mx,iv,P,'out/'+lid)))
