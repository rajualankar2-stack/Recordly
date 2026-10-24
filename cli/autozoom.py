#!/usr/bin/env python3
"""Cursor-following auto-zoom post-processor for Recordly CLI recordings."""
import sys, json, subprocess, time, os
import numpy as np
from PIL import Image, ImageDraw

inp = sys.argv[1]
cursor_path = sys.argv[2]
click_path = sys.argv[3]
zoom = float(sys.argv[4])
outp = sys.argv[5]

# Load cursor samples
samples = []
with open(cursor_path) as f:
    for line in f:
        line = line.strip()
        if line:
            samples.append(json.loads(line))
# Load clicks
clicks = []
if os.path.exists(click_path):
    with open(click_path) as f:
        for line in f:
            line = line.strip()
            if line:
                clicks.append(json.loads(line))

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

# Cursor speed per sample
speeds = np.zeros(len(xs))
for i in range(1, len(xs)):
    dt = ts[i] - ts[i-1]
    if dt <= 0: dt = 1e-3
    speeds[i] = np.hypot(xs[i]-xs[i-1], ys[i]-ys[i-1]) / dt
speeds_s = ema(speeds, 0.1)
# normalize to 0..1
smin, smax = np.percentile(speeds_s, 5), np.percentile(speeds_s, 95)
if smax - smin < 1e-6:
    smax = smin + 1
activity = np.clip((speeds_s - smin) / (smax - smin), 0, 1)
# zoom level per sample: 1.0 when idle, maxZoom when active
zoom_samples = 1.0 + (zoom - 1.0) * activity
zoom_samples = ema(zoom_samples, 0.08)

def cursor_at(t):
    x = float(np.interp(t, ts, xs_s))
    y = float(np.interp(t, ts, ys_s))
    z = float(np.interp(t, ts, zoom_samples))
    return x * scale, y * scale, z

# Crop size (computed per frame now)
pass

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
    cx, cy, cz = cursor_at(t)
    cw = int(W / cz)
    ch = int(H / cz)
    # clamp crop top-left
    left = int(cx - cw / 2)
    top = int(cy - ch / 2)
    left = max(0, min(W - cw, left))
    top = max(0, min(H - ch, top))
    crop = img.crop((left, top, left + cw, top + ch))
    out_img = crop.resize((W, H), Image.LANCZOS)
    # Draw click ripples
    if clicks:
        overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        for c in clicks:
            age = t - c['t']
            if 0 <= age <= 0.5:
                kx = (c['x'] * scale - left) * (W / cw)
                ky = (c['y'] * scale - top) * (H / ch)
                r = int(8 + age * 80)
                a = int(220 * (1 - age / 0.5))
                od.ellipse((kx - r, ky - r, kx + r, ky + r), outline=(255, 60, 60, a), width=3)
        out_img = Image.alpha_composite(out_img.convert('RGBA'), overlay).convert('RGB')
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
