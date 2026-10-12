# Audit 2026-10-12: loon-lake-noble carried Steuben's OSM bbox/point (way 398449807), and Noble's 0-90ft PDF lines
# had been clipped onto Steuben's Loon Lake. Restore both lakes' lines from their county batch outputs (verified vs OSM:
# Noble = way 31012503 @41.27,-85.54; Steuben = way 398449807 @41.65,-85.05).
import json,sys
root=sys.argv[1]
B={b:[f for f in json.load(open(f'contour-batches/{b}/contours.geojson'))['features'] if f['properties'].get('lake')=='Loon Lake'] for b in['Noble','Steuben']}
meta={'Noble':dict(lake_id='loon-lake-noble',contour_method='traced_from_pdf',line_style='solid',depth_assignment='pdf_label'),
      'Steuben':dict(lake_id='loon-lake-steuben',contour_method='traced_from_pdf',line_style='solid',depth_assignment='pdf_label')}
for cp in [f'{root}/data/contours.geojson']+([f'{root}/public/data/contours.geojson'] if len(sys.argv)<3 else []):
  D=json.load(open(cp));D['features']=[f for f in D['features'] if f['properties'].get('lake')!='Loon Lake']
  for b,fs in B.items():
    for f in fs: f['properties'].update(meta[b]);f['properties']['georef_method']='county_batch_restore'
    D['features']+=fs
  json.dump(D,open(cp,'w'),separators=(',',':'))
for lp in [f'{root}/data/lakes.geojson']+([f'{root}/public/data/lakes.geojson'] if len(sys.argv)<3 else []):
  D=json.load(open(lp))
  for f in D['features']:
    p=f['properties']
    if p['id']=='loon-lake-noble':
      p.update(bbox=[-85.544752,41.265566,-85.53173,41.282043],georef_source='osm:way/31012503',georef_method='similarity_ecc',depth_assignment='hand_visual_confirmed_intervals',shore_iou=0.853,shore_acres=None,frac_inside=None,
        precision_note='Restored 2026-10-12 from Noble batch: DNR PDF digitized, georeferenced to OSM way 31012503 (IoU 0.85). Previously mislocated onto Steuben Loon Lake.')
      f['geometry']={'type':'Point','coordinates':[-85.539239,41.272209]}
    if p['id']=='loon-lake-steuben':
      p.update(max_contour_ft=20,depth_assignment='pdf_label',precision_note='Restored 2026-10-12 from Steuben batch (DNR PDF, 0-20 ft). Previously showed Noble Loon Lake depths.')
  json.dump(D,open(lp,'w'),separators=(',',':'))
print('done',root)
