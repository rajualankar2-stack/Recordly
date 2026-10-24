#!/usr/bin/env python3
import ctypes, time, sys, json

out_path = sys.argv[1]
CG = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
CG.CGEventCreate.argtypes = [ctypes.c_void_p]
CG.CGEventCreate.restype = ctypes.c_void_p
CG.CGEventGetLocation.argtypes = [ctypes.c_void_p]
CG.CGEventGetLocation.restype = CGPoint

f = open(out_path, 'w')
start = time.time()
try:
    while True:
        e = CG.CGEventCreate(None)
        p = CG.CGEventGetLocation(e)
        t = time.time() - start
        f.write(json.dumps({'t': t, 'x': p.x, 'y': p.y}) + '\n')
        f.flush()
        time.sleep(1.0 / 60.0)
except KeyboardInterrupt:
    pass
finally:
    f.close()
