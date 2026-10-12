# Merge DNR-PDF re-traced contours (contour-batches/_retrace_2026-10-12) for verified review lakes.
import json,sys,datetime
from shapely.geometry import shape
R='contour-batches/_retrace_2026-10-12/'
PASS={
 'webster-lake-kosciusko':dict(m='pdf_vector_label_nesting',src='osm:relation/2593731',iou=0.883,note='DNR BioBase PDF vector contours; depths from PDF labels (+nesting); georef by PDF scale bar + OSM shoreline match (IoU 0.88).'),
 'hackenburg-lake':dict(m='pdf_vector_label_nesting',src='osm:way/966279067',iou=0.63,note='DNR BioBase PDF vector contours with PDF depth labels; georef scale bar + OSM. East arm on PDF lies outside the OSM lake polygon and is not shown.'),
 'lake-of-the-woods-steuben':dict(m='pdf_vector_label_nesting',src='osm:way/149473410',iou=0.941,note='DNR BioBase PDF vector contours with PDF depth labels; georef scale bar + OSM (IoU 0.94).'),
 'round-lake-noble':dict(m='pdf_vector_label_nesting',src='osm:way/149488490',iou=0.913,note='DNR BioBase PDF vector contours with PDF depth labels; georef scale bar + OSM (IoU 0.91).'),
 'waldron-lake-noble':dict(m='pdf_vector_label_nesting',src='osm:way/32947407',iou=0.647,note='DNR LARE PDF vector contours with PDF depth labels; georef from 1:6,820 map scale + OSM water polygon (chain polygon clipped to Waldron).'),
 'oswego-lake':dict(m='pdf_vector_nesting',src='osm:way/1168964540',iou=0.833,note='DNR BioBase PDF (Oswego/Tippecanoe sheet) vector contours, 10 ft interval by nesting (PDF shows 10/20/30 ft rings only); georef scale bar + OSM.'),
 'indian-lake-dekalb':dict(m='pdf_color_ramp_isolines',src='osm:way/702471901',iou=0.961,note='Isolines from the DNR cBioBase depth color ramp, calibrated to the drawn contour lines (resid 0.7 ft); georef OSM shoreline match (IoU 0.96).'),
 'dillards-pit':dict(m='pdf_color_ramp_isolines',src='osm:way/145076913',iou=0.86,note='Isolines from the DNR cBioBase depth color ramp, calibrated to drawn contour lines (resid 0.2 ft); georef OSM (IoU 0.86).'),
 'little-cedar-lake-whitley':dict(m='pdf_color_ramp_isolines',src='osm',iou=0.899,interval=5,note='Isolines from the DNR cBioBase depth color ramp; drawn lines are every 5 ft (calibration resid 0.2 ft); georef OSM (IoU 0.90).'),
 'loon-lake-noble':dict(m='pdf_color_ramp_isolines',src='osm:way/31012503',iou=0.967,note='Isolines from the DNR cBioBase depth color ramp, calibrated to drawn contour lines (resid 1.0 ft); georef OSM way 31012503 (IoU 0.97). Replaces noisy earlier digitization.'),
}
ids=sys.argv[1:] or list(PASS)
for root in ['.']:
  for cp in ['data/contours.geojson','public/data/contours.geojson']:
    D=json.load(open(cp));n0=len(D['features'])
    D['features']=[f for f in D['features'] if f['properties'].get('lake_id') not in ids]
    for i in ids: D['features']+=json.load(open(R+i+'.geojson'))['features']
    json.dump(D,open(cp,'w'),separators=(',',':'));print(cp,n0,'->',len(D['features']))
  for lp in ['data/lakes.geojson','public/data/lakes.geojson']:
    D=json.load(open(lp))
    for f in D['features']:
      p=f['properties'];i=p['id']
      if i not in ids: continue
      G=json.load(open(R+i+'.geojson'))['features'];c=PASS[i]
      lv=[g['properties']['depth_ft'] for g in G if g['properties']['depth_ft']>0]
      sh=[shape(g['geometry']) for g in G if g['properties']['line_type']=='SHORELINE']
      xs=[x for s in sh for x,y in s.coords];ys=[y for s in sh for x,y in s.coords]
      p.update(needs_review=False,review_priority=None,review_notes=None,contour_method='traced_from_pdf',line_style='solid',
        depth_assignment=c['m'],georef_method='retrace_2026-10-12',georef_source=c['src'],shore_iou=c['iou'],frac_inside=1.0,
        max_contour_ft=max(lv),min_contour_ft=0,precision_note=c['note']+' Re-traced 2026-10-12; structure aid only, not a sonar substitute.',
        bbox=[round(min(xs),6),round(min(ys),6),round(max(xs),6),round(max(ys),6)],data_quality='ok')
      if c.get('interval'): p['contour_interval_ft']=c['interval']
    json.dump(D,open(lp,'w'),separators=(',',':'))
print('merged',ids)
