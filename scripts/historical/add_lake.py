import json,math,shutil,os,sys
from shapely.geometry import mapping,shape
from shapely.ops import polylabel
APP='/workspace/mikes-fishing-app'
def backup(name):
    d=f'{APP}/backups/{name}'
    assert not os.path.exists(d),d
    os.makedirs(d)
    for f in ['lakes.geojson','contours.geojson']: shutil.copy(f'{APP}/public/data/{f}',d)
    return d
def add(props,feats,poly):
    L=json.load(open(f'{APP}/public/data/lakes.geojson'));C=json.load(open(f'{APP}/public/data/contours.geojson'))
    lid=props['id']
    assert not any(x['properties']['id']==lid for x in L['features']),lid
    big=max(getattr(poly,'geoms',[poly]),key=lambda g:g.area)
    pt=polylabel(big,0.00002)
    ds=sorted(set(d for d,_ in feats))
    b=poly.bounds
    base=dict(id=lid,name=None,source_lake_name=None,county=None,county2=None,acres=None,max_depth_ft=None,survey_date=None,
      contour_interval_ft=None,min_contour_ft=ds[0],max_contour_ft=ds[-1],has_contours=True,pdf_url=None,
      bbox=[round(v,6) for v in b],source=None,source_url=None,contour_method=None,georef_method=None,depth_assignment=None,
      needs_review=True,review_priority=None,review_notes=None,line_style='dashed',data_quality=None,shore_iou=None,
      shore_acres=round(poly.area*111320*math.cos(math.radians(pt.y))*110574/4046.86,1),debug_note=None,accuracy_note=None)
    base.update(props)
    L['features'].append({'type':'Feature','geometry':{'type':'Point','coordinates':[round(pt.x,6),round(pt.y,6)]},'properties':base})
    for d,g in feats:
        C['features'].append({'type':'Feature','geometry':{'type':'LineString','coordinates':[[round(x,6),round(y,6)] for x,y in g.coords]},
          'properties':{'lake':base['name'],'depth_ft':d,'line_type':'INDEX' if d%10==0 else 'INTERMEDIATE','contour_method':base['contour_method'],
          'line_style':base['line_style'],'georef_method':base['georef_method'],'depth_assignment':base['depth_assignment'],'lake_id':lid}})
    for p in ['public/data','data']:
        json.dump(L,open(f'{APP}/{p}/lakes.geojson','w'),separators=(',',':'));json.dump(C,open(f'{APP}/{p}/contours.geojson','w'),separators=(',',':'))
    return base
