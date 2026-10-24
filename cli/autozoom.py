#!/usr/bin/env python3
"""Cursor-following auto-zoom post-processor for Recordly CLI recordings."""
import sys, json, subprocess, time, os
import numpy as np
from PIL import Image

inp = sys.argv[1]
cursor_path = sys.argv[2]
zoom = float(sys.argv[3])
outp = sys.argv[4]

# Load cursor samples
samples = []
with open(cursor_path) as f:
    for line in f:
        line = line.strip()
        if line:
            samples.append(json.loads(line))
if not samples:
    print("No cursor samples; copying input")
    subprocess.run(['ffmpeg','-y','-i',inp,'-c','copy',outp], check=True)
    sys.exit(0)

ts = np.array([s['t'] for s in samples], dtype=float)
xs = np.array([s['x'] for s in samples], dtype=float)
ys = np.array([s['y'] for s in samples], dtype=float)

# Video info
probe = subprocess.run(['ffprobe','-v','error','-select_streams','v:0',
    '-show_entries','stream=width,height,r_frame_rate','-of','json',inp],
    capture_output=True, text=True, check=True)
info = json.loads(probe.stdout)['streams'][0]
W, H = info['width'], info['height']
fr = info['r_frame_rate']
num, den = fr.split('/')
fps = float(num) / float(den)
nframes = None
# total frames via count
cnt = subprocess.run(['ffprobe','-v','error','-count_frames','-select_streams','v:0',
    '-show_entries','stream=nb_read_frames','-of','csv=p=0',inp],
    capture_output=True, text=True)
try:
    nframes = int(cnt.stdout.strip())
except Exception:
    nframes = int(fps * 30)

# backing scale: logical -> pixels
logical_w = 1280.0
scale = W / logical_w

# Smooth cursor positions with EMA
def ema(arr, alpha=0.15):
    out = arr.copy()
    for i in range(1, len(arr)):
        out[i] = alpha * arr[i] + (1 - alpha) * out[i-1]
    return out
xs_s = ema(xs)
ys_s = ema(ys)

def cursor_at(t):
    x = float(np.interp(t, ts, xs_s))
    y = float(np.interp(t, ts, ys_s))
    return x * scale, y * scale

# Crop size
cw = int(W / zoom)
ch = int(H / zoom)

# Decoder
dec = subprocess.Popen(
    ['ffmpeg','-hide_banner','-loglevel','error','-i',inp,
     '-f','rawvideo','-pix_fmt','rgb24','-'],
    stdout=subprocess.PIPE)
# Encoder (video only)
enc = subprocess.Popen(
    ['ffmpeg','-hide_banner','-loglevel','error','-y',
     '-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(fps),'-i','-',
     '-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',outp],
    stdin=subprocess.PIPE)

frame_size = W * H * 3
i = 0
while True:
    raw = dec.stdout.read(frame_size)
    if len(raw) < frame_size:
        break
    img = Image.frombytes('RGB', (W, H), raw)
    t = i / fps
    cx, cy = cursor_at(t)
    # clamp crop top-left
    left = int(cx - cw / 2)
    top = int(cy - ch / 2)
    left = max(0, min(W - cw, left))
    top = max(0, min(H - ch, top))
    crop = img.crop((left, top, left + cw, top + ch))
    out_img = crop.resize((W, H), Image.LANCZOS)
    enc.stdin.write(out_img.tobytes())
    i += 1
    if i % 60 == 0:
        print(f"processed {i} frames", flush=True)

dec.stdout.close()
dec.wait()
enc.stdin.close()
enc.wait()
print(f"done: {i} frames -> {outp}")

# Mux audio from original if present
tmp = outp + '.tmp.mp4'
os.replace(outp, tmp)
# try mux audio
r = subprocess.run(['ffmpeg','-y','-i',tmp,'-i',inp,
    '-c','copy','-map','0:v:0','-map','1:a:0?',tmp.replace('.tmp.mp4','.final.mp4')],
    capture_output=True)
if r.returncode == 0 and os.path.exists(tmp.replace('.tmp.mp4','.final.mp4')):
    os.replace(tmp.replace('.tmp.mp4','.final.mp4'), outp)
    os.remove(tmp)
else:
    os.replace(tmp, outp)
