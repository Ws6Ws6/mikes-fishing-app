# Audit 2026-10-12: keep deeper lines but flag lakes whose contours go deeper than DNR's published vector contours.
import json,sys
FL={'tippecanoe-lake':40,'sand-lake':30}
for path in sys.argv[1:]:
  D=json.load(open(path))
  for f in D['features']:
    p=f['properties']
    if p['id'] in FL:
      p['dnr_vector_max_contour_ft']=FL[p['id']];p['exceeds_dnr_max']=True
      p['exceeds_dnr_note']=f"App contours go to {p.get('max_contour_ft')} ft, deeper than Indiana DNR's published vector contours (deepest {FL[p['id']]} ft). Deeper lines are digitized from the DNR PDF and less certain."
  json.dump(D,open(path,'w'),separators=(',',':'));print('flagged',path)
