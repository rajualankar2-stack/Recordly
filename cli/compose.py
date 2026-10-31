#!/usr/bin/env python3
"""VidCLI compose: put narration, captions, music and a gentle ending on a recorded take.

Usage:
  vidcli compose --video take.mp4 --lines lines.json -o final.mp4 [options]

lines.json:
  {"lines": [
     {"wav": "/abs/v0.wav", "ts": 1793420000000, "caption": "Open the app"},   # ts = epoch ms
     {"wav": "/abs/v1.wav", "at": 12.5,           "caption": "Click save"}     # at = seconds into the video
  ]}

Timing: a line with `ts` is placed at (ts - manifest.started_at)/1000 - offset. The manifest is
<video>.json (written by `vidcli record`) or --manifest. `at` is used as-is (minus nothing).

Options:
  --music FILE      background bed (ducked under speech, fades out)
  --offset SEC      capture start latency; subtract from ts-based times (default 0.0)
  --end-hold SEC    hold the last frame this long after the last line (default 2.2)
  --no-pad          draw captions over the video instead of a strip below it
  --width PX        output width (default: source width, max 1920)
  --dry             print the timeline and exit
"""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

ACCENT = (255, 106, 0)


def die(msg):
    print(f"compose: {msg}", file=sys.stderr)
    sys.exit(2)


def parse(argv):
    o = {"video": None, "lines": None, "out": None, "manifest": None, "music": None, "offset": 0.0,
         "end_hold": 2.2, "pad": True, "width": None, "dry": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--video": i += 1; o["video"] = argv[i]
        elif a == "--lines": i += 1; o["lines"] = argv[i]
        elif a in ("-o", "--output"): i += 1; o["out"] = argv[i]
        elif a == "--manifest": i += 1; o["manifest"] = argv[i]
        elif a == "--music": i += 1; o["music"] = argv[i]
        elif a == "--offset": i += 1; o["offset"] = float(argv[i])
        elif a == "--end-hold": i += 1; o["end_hold"] = float(argv[i])
        elif a == "--width": i += 1; o["width"] = int(argv[i])
        elif a == "--no-pad": o["pad"] = False
        elif a == "--dry": o["dry"] = True
        elif a in ("-h", "--help"): print(__doc__); sys.exit(0)
        else: die(f"unknown argument {a}")
        i += 1
    for k, flag in (("video", "--video"), ("lines", "--lines")):
        if not o[k]: die(f"{flag} is required")
    if not o["out"] and not o["dry"]: die("-o is required")
    return o


def probe(path, entries):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", entries, "-of", "json", path],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        die(f"cannot read {path}")


def duration(path):
    return float(probe(path, "format=duration")["format"]["duration"])


def font_for(px):
    for p in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, px)
    return ImageFont.load_default()


def caption_png(text, width, height, path):
    img = Image.new("RGB", (width, height), (0, 0, 0))
    d = ImageDraw.Draw(img)
    font = font_for(int(height * 0.55))
    while d.textlength(text, font=font) > width - 60 and font.size > 14:
        font = font_for(font.size - 2)
    w = d.textlength(text, font=font)
    d.rectangle([0, 0, max(6, height // 7), height], fill=ACCENT)
    d.text(((width - w) / 2, (height - font.size) / 2 - 2), text, font=font, fill=(255, 255, 255))
    img.save(path)


def main():
    o = parse(sys.argv[1:])
    if not os.path.exists(o["video"]): die(f"video not found: {o['video']}")
    spec = json.load(open(o["lines"]))
    lines = spec.get("lines", [])
    manifest_path = o["manifest"] or os.path.splitext(o["video"])[0] + ".json"
    started = None
    if os.path.exists(manifest_path):
        started = json.load(open(manifest_path)).get("started_at")

    vdur = duration(o["video"])
    vinfo = probe(o["video"], "stream=width,height,codec_type")["streams"]
    vs = next(s for s in vinfo if s.get("codec_type") == "video")
    src_w, src_h = int(vs["width"]), int(vs["height"])

    placed = []
    t = 0.0
    for n, ln in enumerate(lines):
        if "ts" in ln:
            if started is None: die(f"line {n} uses ts but no manifest started_at found at {manifest_path}")
            t = (ln["ts"] - started) / 1000.0 - o["offset"]
        elif "at" in ln:
            t = float(ln["at"])
        else:
            die(f"line {n} needs ts or at")
        wav = ln.get("wav")
        if wav and not os.path.exists(wav): die(f"line {n}: wav not found: {wav}")
        d = duration(wav) if wav else 2.0
        placed.append({"t": max(0.0, t), "dur": d, "wav": wav, "caption": ln.get("caption")})
    placed.sort(key=lambda p: p["t"])

    last_end = max([p["t"] + p["dur"] for p in placed], default=0.0)
    total = max(vdur, last_end + o["end_hold"]) if placed else vdur
    freeze = max(0.0, total - vdur)

    out_w = min(o["width"] or src_w, 1920)
    out_w -= out_w % 2
    vid_h = int(round(out_w * src_h / src_w)); vid_h -= vid_h % 2
    strip_h = max(40, int(out_w * 72 / 1920)); strip_h -= strip_h % 2
    has_caps = any(p["caption"] for p in placed)
    pad = o["pad"] and has_caps
    full_h = vid_h + strip_h if pad else vid_h

    timeline = [{"t": round(p["t"], 2), "end": round(p["t"] + p["dur"], 2), "caption": p["caption"]} for p in placed]
    summary = {"video_s": round(vdur, 2), "total_s": round(total, 2), "freeze_s": round(freeze, 2),
               "lines": timeline}
    if o["dry"]:
        print(json.dumps(summary, indent=2)); return

    tmp = tempfile.mkdtemp(prefix="vidcli-compose-", dir=os.path.dirname(os.path.abspath(o["out"])))
    try:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", o["video"]]
        voices = [p for p in placed if p["wav"]]
        for p in voices: cmd += ["-i", p["wav"]]
        music_idx = None
        if o["music"]:
            music_idx = 1 + len(voices)
            cmd += ["-i", o["music"]]
        caps = [p for p in placed if p["caption"]]
        cap_idx0 = 1 + len(voices) + (1 if o["music"] else 0)
        for i, p in enumerate(caps):
            png = os.path.join(tmp, f"c{i}.png")
            caption_png(p["caption"], out_w, strip_h, png)
            cmd += ["-loop", "1", "-i", png]

        chain = []
        base = f"[0:v]"
        if freeze > 0.05:
            chain.append(f"{base}tpad=stop_mode=clone:stop_duration={freeze:.2f}[vf]"); base = "[vf]"
        if pad:
            chain.append(f"{base}scale={out_w}:{vid_h},pad={out_w}:{full_h}:0:0:black[v0]")
        else:
            chain.append(f"{base}scale={out_w}:{vid_h}[v0]")
        cur = "v0"
        for i, p in enumerate(caps):
            nxt = caps[i + 1]["t"] if i + 1 < len(caps) else total
            end = min(p["t"] + p["dur"] + 0.4, nxt) if i + 1 < len(caps) else p["t"] + p["dur"] + 0.4
            y = vid_h if pad else vid_h - strip_h
            chain.append(f"[{cur}][{cap_idx0 + i}:v]overlay=0:{y}:enable='between(t,{p['t']:.2f},{end:.2f})':shortest=0[v{i + 1}]")
            cur = f"v{i + 1}"
        chain.append(f"[{cur}]fade=t=out:st={max(0.0, total - 2.0):.2f}:d=1.8[vout]")

        audio = []
        have_voice = bool(voices)
        if have_voice:
            labs = []
            for i, p in enumerate(voices, 1):
                ms = int(p["t"] * 1000)
                audio.append(f"[{i}:a]aresample=48000,adelay={ms}|{ms}[a{i}]"); labs.append(f"[a{i}]")
            tail = "asplit=2[vo][vs]" if music_idx is not None else "anull[vo]"
            audio.append("".join(labs) + f"amix=inputs={len(voices)}:normalize=0,apad,atrim=0:{total:.2f},"
                         f"loudnorm=I=-16:TP=-1.5:LRA=11,{tail}")
        if music_idx is not None:
            m = (f"[{music_idx}:a]aresample=48000,aloop=loop=-1:size=2000000000,atrim=0:{total:.2f},asetpts=PTS-STARTPTS,"
                 f"volume=0.2,afade=t=in:d=3,afade=t=out:st={max(0.0, total - 6.5):.2f}:d=6.4")
            if have_voice:
                audio.append(m + "[m]")
                audio.append("[m][vs]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=500:makeup=1[md]")
                audio.append("[vo][md]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
            else:
                audio.append(m + ",loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
        elif have_voice:
            audio[-1] = audio[-1].replace("[vo]", "[aout]")

        cmd += ["-filter_complex", ";".join(chain + audio), "-map", "[vout]"]
        if have_voice or music_idx is not None:
            cmd += ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"]
        else:
            cmd += ["-an"]
        cmd += ["-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", o["out"]]
        r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        if r.returncode != 0:
            die(f"ffmpeg failed: {r.stderr[-400:]}")
    finally:
        for f in os.listdir(tmp): os.remove(os.path.join(tmp, f))
        os.rmdir(tmp)

    summary["output"] = o["out"]
    summary["output_s"] = round(duration(o["out"]), 2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
