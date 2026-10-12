# Merge Sylvan draft re-trace (both basins) but keep it flagged Needs review.
import json
from shapely.geometry import shape
G=json.load(open('contour-batches/_retrace_2026-10-12/sylvan-lake-east-west-noble.geojson'))['features']
G=[g for g in G if g['geometry']['type']=='LineString' and len(g['geometry']['coordinates'])>1]
NOTE=("Draft re-trace 2026-10-12 from DNR BioBase 2021 West and East Basin PDFs: PDF vector lines, depths assigned by hand per region, georef scale bar + USGS NHD outline (IoU 0.82 W / 0.87 E). "
 "West basin agrees with all PDF labels. East basin: the DNR labels on the deep south-east hole conflict (15 outer, 25 on 2nd ring, 20 by innermost), so inner ring depths there are uncertain; "
 "one 10 ft segment in the East main basin could not be recovered. Needs review; structure aid only, not a sonar substitute.")
for cp in ['data/contours.geojson','public/data/contours.geojson']:
  D=json.load(open(cp));n0=len(D['features'])
  D['features']=[f for f in D['features'] if f['properties'].get('lake_id')!='sylvan-lake-east-west-noble']+G
  json.dump(D,open(cp,'w'),separators=(',',':'));print(cp,n0,'->',len(D['features']))
for lp in ['data/lakes.geojson','public/data/lakes.geojson']:
  D=json.load(open(lp))
  for f in D['features']:
    p=f['properties']
    if p['id']!='sylvan-lake-east-west-noble': continue
    lv=[g['properties']['depth_ft'] for g in G if g['properties']['depth_ft']>0]
    xs=[c[0] for g in G for c in g['geometry']['coordinates']];ys=[c[1] for g in G for c in g['geometry']['coordinates']]
    p.update(needs_review=True,review_notes=NOTE,precision_note=NOTE,contour_method='traced_from_pdf',depth_assignment='pdf_vector_manual_regions',
      georef_method='retrace_2026-10-12',georef_source='usgs:nhd waterbody',shore_iou=0.87,max_contour_ft=max(lv),min_contour_ft=0,
      bbox=[round(min(xs),6),round(min(ys),6),round(max(xs),6),round(max(ys),6)],data_quality='needs_review')
    print('lake updated',max(lv),sorted(set(lv)))
  json.dump(D,open(lp,'w'),separators=(',',':'))
