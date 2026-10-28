import sys;sys.path.insert(0,".")
import numpy as np,cv2,pickle
from rtrace2 import trace
k=np.load('thin.npy')
paths=trace(k,z=1,minlen_pt=25,gap_pt=4)
paths=[np.array(p) for p in paths]
from shapely.geometry import LineString
paths=[p for p in paths if LineString(p).length>60]
print(len(paths))
pickle.dump(paths,open('paths.pkl','wb'))
