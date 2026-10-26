#!/usr/bin/env python3
"""Cursor-following auto-zoom post-processor for Recordly CLI recordings.

Intelligent mode: zooms in only on real activity (movement bursts / clicks),
holds while active, pans to new areas, and eases back to 1x when idle.
"""
import sys, json, subprocess, time, os
import numpy as np
_start_time = time.time()
from PIL import Image, ImageDraw, ImageFilter

inp = sys.argv[1]
cursor_path = sys.argv[2]
click_path = sys.argv[3]
zoom = float(sys.argv[4])
outp = sys.argv[5]
redact_str = sys.argv[6] if len(sys.argv) > 6 else None
auto_mode = sys.argv[7] if len(sys.argv) > 7 else ''
if redact_str == '':
    redact_str = None

redact_regions = []

# Auto-redact: detect text regions via OCR on sampled frames
if auto_mode in ('sensitive', 'all'):
    import re, tempfile
    # probe duration
    probe2 = subprocess.run(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=duration','-of','json',inp], capture_output=True, text=True)
    try:
        dur = float(json.loads(probe2.stdout)['streams'][0]['duration'])
    except Exception:
        dur = 10.0
    sample_times = sorted(set([0.0, dur/2.0, max(0.0, dur-1.0)]))
    email_re = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
    phone_re = re.compile(r'(\+?\d[\d\s\-()]{7,}\d)')
    card_re = re.compile(r'\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b')
    boxes = []

    def add_box(left, top, w, h, pad=8):
        boxes.append((max(0, left - pad), max(0, top - pad), w + 2 * pad, h + 2 * pad))

    for t in sample_times:
        tmp = tempfile.mktemp(suffix='.png')
        subprocess.run(['ffmpeg','-y','-ss',str(t),'-i',inp,'-vframes','1',tmp],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if not os.path.exists(tmp):
            continue
        r = subprocess.run(['tesseract',tmp,'stdout','tsv'], capture_output=True, text=True)
        try:
            os.remove(tmp)
        except OSError:
            pass
        words = []
        for line in r.stdout.splitlines()[1:]:
            cols = line.split('\t')
            if len(cols) < 12:
                continue
            try:
                level = int(cols[0])
                key = (int(cols[1]), int(cols[2]), int(cols[3]), int(cols[4]))  # page, block, par, line
                left = int(cols[6]); top = int(cols[7]); w = int(cols[8]); h = int(cols[9])
                conf = float(cols[10]); text = cols[11].strip()
            except ValueError:
                continue
            if level != 5 or not text or w <= 0 or h <= 0:
                continue
            words.append((key, left, top, w, h, conf, text))
        if auto_mode == 'all':
            for (_key, left, top, w, h, conf, _text) in words:
                if conf >= 30:
                    add_box(left, top, w, h)
            continue
        # Match whole OCR lines, not single words: tesseract splits "+1 555 0100" and
        # "4242 4242 4242 4242" into separate words, so per-word matching missed them.
        lines = {}
        for wd in words:
            lines.setdefault(wd[0], []).append(wd)
        for line_words in lines.values():
            line_words.sort(key=lambda wd: wd[1])
            spans, pos = [], 0
            for wd in line_words:
                spans.append((pos, pos + len(wd[6]), wd))
                pos += len(wd[6]) + 1
            line_text = ' '.join(wd[6] for wd in line_words)
            for rx in (email_re, phone_re, card_re):
                for m in rx.finditer(line_text):
                    hit = [wd for (a, b, wd) in spans if a < m.end() and b > m.start()]
                    if not hit:
                        continue
                    x0 = min(wd[1] for wd in hit); y0 = min(wd[2] for wd in hit)
                    x1 = max(wd[1] + wd[3] for wd in hit); y1 = max(wd[2] + wd[4] for wd in hit)
                    add_box(x0, y0, x1 - x0, y1 - y0)
    # merge overlapping boxes
    merged = []
    for b in boxes:
        (x,y,w,h) = b
        merged_into = False
        for i,m in enumerate(merged):
            (mx,my,mw,mh) = m
            # overlap check
            if not (x > mx+mw or x+w < mx or y > my+mh or y+h < my):
                # merge
                nx = min(x, mx); ny = min(y, my)
                nw = max(x+w, mx+mw) - nx
                nh = max(y+h, my+mh) - ny
                merged[i] = (nx, ny, nw, nh)
                merged_into = True
                break
        if not merged_into:
            merged.append(b)
    for (x,y,w,h) in merged:
        redact_regions.append([x, y, w, h])
    print(f"auto-redact: detected {len(merged)} regions", flush=True)

if redact_str:
    for part in redact_str.split(';'):
        part = part.strip()
        if not part:
            continue
        nums = [int(x) for x in part.split(',')]
        if len(nums) == 4:
            redact_regions.append(nums)

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

if not samples and not redact_regions:
    print("No cursor samples; copying input")
    subprocess.run(['ffmpeg','-y','-i',inp,'-c','copy',outp], check=True)
    sys.exit(0)

if not samples:
    samples = [{'t': 0.0, 'x': 640.0, 'y': 360.0}]

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

# estimate total frames for ETA
try:
    p2 = subprocess.run(['ffprobe','-v','error','-show_entries','format=duration',
        '-of','json',inp], capture_output=True, text=True, check=True)
    _dur = float(json.loads(p2.stdout)['format']['duration'])
    est_total = int(_dur * fps)
except Exception:
    est_total = 0

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
     '-c:v','libx264','-preset','ultrafast','-crf','20','-pix_fmt','yuv420p',outp],
    stdin=subprocess.PIPE)

frame_size = W * H * 3
i = 0
while True:
    raw = dec.stdout.read(frame_size)
    if len(raw) < frame_size:
        break
    img = Image.frombytes('RGB', (W, H), raw)
    # Redact sensitive regions (blur)
    if redact_regions:
        for (rx, ry, rw, rh) in redact_regions:
            rx = max(0, rx); ry = max(0, ry)
            rw = min(rw, W - rx); rh = min(rh, H - ry)
            if rw <= 0 or rh <= 0:
                continue
            region = img.crop((rx, ry, rx + rw, ry + rh))
            blurred = region.filter(ImageFilter.GaussianBlur(radius=12))
            img.paste(blurred, (rx, ry))
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
    out_img = crop.resize((W, H), Image.BILINEAR)

    if clicks:
        recent_clicks = [c for c in clicks if 0 <= t - c['t'] <= 0.5]
        if recent_clicks:
            overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            for c in recent_clicks:
                age = t - c['t']
                kx = (c['x'] * scale - left) * (W / cw)
                ky = (c['y'] * scale - top) * (H / ch)
                r = int(8 + age * 80)
                a = int(220 * (1 - age / 0.5))
                od.ellipse((kx - r, ky - r, kx + r, ky + r), outline=(255, 60, 60, a), width=3)
            out_img = Image.alpha_composite(out_img.convert('RGBA'), overlay).convert('RGB')

    enc.stdin.write(out_img.tobytes())
    i += 1
    if i % 60 == 0:
        elapsed = time.time() - _start_time
        rate = i / elapsed if elapsed > 0 else 0
        if est_total > 0 and rate > 0:
            remaining = (est_total - i) / rate
            print(f"processed {i}/{est_total} frames (ETA {remaining:.0f}s)", flush=True)
        else:
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
