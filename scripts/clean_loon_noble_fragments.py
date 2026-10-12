# Drop tiny (<150 m) digitization fragments on Noble Loon Lake that clutter depth labels; keep deepest level lines.
import json,math,sys
for cp in sys.argv[1:]:
  D=json.load(open(cp));n0=len(D['features'])
  def ln(g):
    cs=[g['coordinates']] if g['type']=='LineString' else g['coordinates']
    return sum(math.dist(c[i],c[i+1]) for c in cs for i in range(len(c)-1))*111000
  D['features']=[f for f in D['features'] if not(f['properties'].get('lake_id')=='loon-lake-noble' and f['properties']['depth_ft']<80 and ln(f['geometry'])<150)]
  json.dump(D,open(cp,'w'),separators=(',',':'));print(cp,n0-len(D['features']),'removed')
