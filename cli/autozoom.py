#!/usr/bin/env python3
"""Cursor-following auto-zoom post-processor for Recordly CLI recordings.

Intelligent mode: zooms in only on real activity (movement bursts / clicks),
holds while active, pans to new areas, and eases back to 1x when idle.
"""
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
if os.path.exists(cursor_path):
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

probe = subprocess.run(['ffprobe','-v','error','-select_streams','v:0',
    '-show_entries','stream=width,height,r_frame_rate','-of','json',inp],
    capture_output=True, text=True, check=True)
info = json.loads(probe.stdout)['streams'][0]
W, H = info['width'], info['height']
fr = info['r_frame_rate']
num, den = fr.split('/')
fps = float(num) / float(den)

logical_w = 1280.0
scale = W / logical_w

def ema(arr, alpha=0.15):
    out = arr.copy()
    for i in range(1, len(arr)):
        out[i] = alpha * arr[i] + (1 - alpha) * out[i-1]
    return out

xs_s = ema(xs, 0.2)
ys_s = ema(ys, 0.2)

speeds = np.zeros(len(xs))
for i in range(1, len(xs)):
    dt = ts[i] - ts[i-1]
    if dt <= 0: dt = 1e-3
    speeds[i] = np.hypot(xs[i]-xs[i-1], ys[i]-ys[i-1]) / dt
speeds_s = ema(speeds, 0.15)

thr = float(np.percentile(speeds_s, 80))
click_times = [c['t'] for c in clicks]

# State
center_x = W / 2.0
center_y = H / 2.0
zoom_level = 1.0
target_cx = W / 2.0
target_cy = H / 2.0
target_zoom = 1.0
last_active = 0.0
DWELL = 2.0

def cursor_at(t):
    x = float(np.interp(t, ts, xs_s)) * scale
    y = float(np.interp(t, ts, ys_s)) * scale
    sp = float(np.interp(t, ts, speeds_s))
    return x, y, sp

dec = subprocess.Popen(
    ['ffmpeg','-hide_banner','-loglevel','error','-i',inp,
     '-f','rawvideo','-pix_fmt','rgb24','-'],
    stdout=subprocess.PIPE)
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
    cx, cy, sp = cursor_at(t)

    recent_click = any(abs(ct - t) < 0.4 for ct in click_times)

    if recent_click or sp > thr:
        target_cx, target_cy = cx, cy
        target_zoom = zoom
        last_active = t
    else:
        if t - last_active > DWELL:
            target_zoom = 1.0

    zoom_level += (target_zoom - zoom_level) * 0.03
    center_x += (target_cx - center_x) * 0.06
    center_y += (target_cy - center_y) * 0.06
    if zoom_level < 1.05:
        center_x += (W/2 - center_x) * 0.08
        center_y += (H/2 - center_y) * 0.08

    cz = max(1.0, zoom_level)
    cw = int(W / cz)
    ch = int(H / cz)
    left = int(center_x - cw / 2)
    top = int(center_y - ch / 2)
    left = max(0, min(W - cw, left))
    top = max(0, min(H - ch, top))
    crop = img.crop((left, top, left + cw, top + ch))
    out_img = crop.resize((W, H), Image.LANCZOS)

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

tmp = outp + '.tmp.mp4'
os.replace(outp, tmp)
final_tmp = tmp.replace('.tmp.mp4', '.final.mp4')
r = subprocess.run(['ffmpeg','-y','-i',tmp,'-i',inp,
    '-c','copy','-map','0:v:0','-map','1:a:0?',final_tmp],
    capture_output=True)
if r.returncode == 0 and os.path.exists(final_tmp):
    os.replace(final_tmp, outp)
    os.remove(tmp)
else:
    os.replace(tmp, outp)
