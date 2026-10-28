#!/usr/bin/env python3
"""Log the global cursor position (CG points, top-left origin) as JSONL at ~60 Hz.

usage: cursor-log.py <out.jsonl> [--display <id> | --region x,y,w,h]

The first line records the captured area in the same coordinates, so autozoom.py
can map cursor positions into video pixels. Default area: the main display.
"""
import ctypes, time, sys, json

out_path = sys.argv[1]
CG = ctypes.CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
CF = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
class CGPoint(ctypes.Structure):
    _fields_ = [('x', ctypes.c_double), ('y', ctypes.c_double)]
class CGSize(ctypes.Structure):
    _fields_ = [('width', ctypes.c_double), ('height', ctypes.c_double)]
class CGRect(ctypes.Structure):
    _fields_ = [('origin', CGPoint), ('size', CGSize)]
CG.CGEventCreate.argtypes = [ctypes.c_void_p]
CG.CGEventCreate.restype = ctypes.c_void_p
CG.CGEventGetLocation.argtypes = [ctypes.c_void_p]
CG.CGEventGetLocation.restype = CGPoint
CG.CGMainDisplayID.restype = ctypes.c_uint32
CG.CGDisplayBounds.argtypes = [ctypes.c_uint32]
CG.CGDisplayBounds.restype = CGRect
CF.CFRelease.argtypes = [ctypes.c_void_p]

opts = sys.argv[2:]
if len(opts) == 2 and opts[0] == '--region':
    rx, ry, rw, rh = (float(v) for v in opts[1].split(','))
else:
    display_id = int(opts[1]) if len(opts) == 2 and opts[0] == '--display' else CG.CGMainDisplayID()
    b = CG.CGDisplayBounds(display_id)
    rx, ry, rw, rh = b.origin.x, b.origin.y, b.size.width, b.size.height

f = open(out_path, 'w')
f.write(json.dumps({'region': {'x': rx, 'y': ry, 'w': rw, 'h': rh}}) + '\n')
start = time.time()
try:
    while True:
        e = CG.CGEventCreate(None)
        if e:
            p = CG.CGEventGetLocation(e)
            CF.CFRelease(e)  # one CGEvent per sample; unreleased they pile up for the whole recording
            t = time.time() - start
            f.write(json.dumps({'t': t, 'x': p.x, 'y': p.y}) + '\n')
            f.flush()
        time.sleep(1.0 / 60.0)
except KeyboardInterrupt:
    pass
finally:
    f.close()
