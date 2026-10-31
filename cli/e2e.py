#!/usr/bin/env python3
"""End-to-end tests for the new VidCLI features, on real recordings of a real window.

Screen state assumed: Preview is showing board.png with the lines
  hermes-e2e-secret / contact: e2e.test@example.com / card: 4242 4242 4242 4242 / plain line nobody blurs
Every case records for real, then checks the artefact (ffprobe, manifest, OCR, pixel energy).
"""
import json
import os
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(REPO, ".e2e")
OUT = os.path.join(HERE, "runs")
os.makedirs(OUT, exist_ok=True)
os.chdir(REPO)

results = []
os.makedirs(HERE, exist_ok=True)


def sh(cmd, **kw):
    kw.setdefault("errors", "replace")
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def probe(path):
    r = sh(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=width,height",
            "-of", "json", path])
    try:
        d = json.loads(r.stdout)
        s = d["streams"][0]
        return {"dur": float(d["format"]["duration"]), "w": s["width"], "h": s["height"]}
    except Exception:
        return None


_first_focus = [True]


def board_on_screen():
    shot = os.path.join(HERE, "screen_check.png")
    subprocess.run(["screencapture", "-x", shot], capture_output=True)
    r = sh(["tesseract", shot, "stdout"])
    os.path.exists(shot) and os.remove(shot)
    return "nobody" in r.stdout.lower() or "hermes-e2e" in r.stdout.lower()


def focus_board():
    """Bring the test board to the front and confirm it is really on screen (retry up to 4 times)."""
    for attempt in range(4):
        subprocess.run(["open", "-a", "Preview", os.path.join(HERE, "board.png")],
                       capture_output=True, text=True)
        time.sleep(4.5 if _first_focus[0] else 2.0)
        _first_focus[0] = False
        if board_on_screen():
            return True
    print("WARNING: test board not visible on screen", flush=True)
    return False


def board_boxes(path):
    """Locate the four board lines in a recorded frame via OCR (screen coords)."""
    tmp = os.path.join(HERE, "full_frame.png")
    sh(["ffmpeg", "-v", "error", "-y", "-ss", "1.0", "-i", path, "-frames:v", "1", tmp])
    r = sh(["tesseract", tmp, "stdout", "tsv"])
    out = {}
    for line in r.stdout.splitlines()[1:]:
        c = line.split("\t")
        if len(c) < 12 or c[0] != "5":
            continue
        t = c[11].strip().lower()
        try:
            box = (int(c[6]), int(c[7]), int(c[8]), int(c[9]))
        except ValueError:
            continue
        for key in ("hermes-e2e-secret", "secret", "plain", "nobody", "e2e.test", "4242"):
            if key in t and key not in out:
                out[key] = box
    os.path.exists(tmp) and os.remove(tmp)
    return out


def record(name, args, stop_after=None, tone_at=None):
    focus_board()
    out = os.path.join(OUT, f"{name}.mp4")
    cmd = ["node", "cli/record.mjs", "-o", out, "--overwrite", "--json"] + args
    proc_stdout = []
    stopfile = None
    if stop_after:
        stopfile = f"/tmp/e2e-stop-{int(time.time()*1000)}"
        cmd += ["--stop-file", stopfile]
        import threading
        threading.Timer(stop_after, lambda: open(stopfile, "w").write("go")).start()
    if tone_at is not None:
        import threading
        tone = os.path.join(HERE, "tone.wav")
        threading.Timer(tone_at + 0.4, lambda: subprocess.Popen(["afplay", tone])).start()
    r = sh(cmd, timeout=180)
    events = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            events.append({"event": "_NON_JSON_", "raw": line[:80]})
    with open(out.replace(".mp4", ".stdout.txt"), "w") as fh:
        fh.write(r.stdout)
    with open(out.replace(".mp4", ".stderr.txt"), "w") as fh:
        fh.write(r.stderr)
    manifest_path = out.replace(".mp4", ".json")
    manifest = None
    if os.path.exists(manifest_path):
        manifest = json.load(open(manifest_path))
    return {"out": out, "exit": r.returncode, "events": events, "manifest": manifest,
            "manifest_path": manifest_path, "stderr": r.stderr[-300:]}


def ocr_region(path, x, y, w, h, pad=12):
    tmp = os.path.join(HERE, f"crop_{int(time.time()*1000)}.png")
    px, py = max(0, x - pad), max(0, y - pad)
    sh(["ffmpeg", "-v", "error", "-y", "-ss", "1.0", "-i", path, "-frames:v", "1",
        "-vf", f"crop={w + 2 * pad}:{h + 2 * pad}:{px}:{py},scale=iw*2:ih*2", tmp])
    r = sh(["tesseract", tmp, "stdout"])
    os.path.exists(tmp) and os.remove(tmp)
    return r.stdout.lower()


def edge_energy(path, x, y, w, h, below=True):
    import numpy as np
    from PIL import Image
    tmp = os.path.join(HERE, f"ed_{int(time.time()*1000)}.png")
    sh(["ffmpeg", "-v", "error", "-y", "-ss", "1.0", "-i", path, "-frames:v", "1", tmp])
    a = np.array(Image.open(tmp).convert("L")).astype(float)
    os.remove(tmp)
    box = a[y:y + h, x:x + w]
    ctrl_y = y + h if below else y - h
    ctrl = a[max(0, ctrl_y):max(1, ctrl_y + h), x:x + w]
    e = lambda m: float(np.abs(np.diff(m, axis=1)).mean()) if m.size else 0.0
    return round(e(box), 2), round(e(ctrl), 2)


def add(name, ok, detail):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)


def ensure_board():
    from PIL import Image, ImageDraw, ImageFont
    path = os.path.join(HERE, "board.png")
    if os.path.exists(path):
        return path
    f = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 46)
    img = Image.new("RGB", (1180, 760), (250, 250, 250))
    d = ImageDraw.Draw(img)
    for i, t in enumerate(["hermes-e2e-secret", "contact: e2e.test@example.com",
                           "card: 4242 4242 4242 4242", "plain line nobody blurs"]):
        d.text((60, 70 + i * 110), t, font=f, fill=(10, 10, 10))
    img.save(path)
    return path


ensure_board()

# ---------------------------------------------------------------- cases
print("== T1 duration + manifest", flush=True)
r1 = record("t1_duration", ["-d", "3"])
p1 = probe(r1["out"]) if os.path.exists(r1["out"]) else None
m1 = r1["manifest"] or {}
add("T1 file+duration", bool(p1) and 2.0 < p1["dur"] < 4.5, f"dur={p1['dur'] if p1 else None}")
add("T1 manifest anchor", bool(m1.get("started_at")) and bool(m1.get("stopped_at"))
    and abs((m1.get("duration_s") or 0) - (p1["dur"] if p1 else 0)) < 0.4,
    f"started_at={m1.get('started_at')} duration_s={m1.get('duration_s')}")
add("T1 no redaction noise", (m1.get("redactions") in (None, {})), f"redactions={m1.get('redactions')}")

print("== T2 redact-text", flush=True)
r2 = record("t2_redact_text", ["-d", "3", "--redact-text", "hermes-e2e-secret", "--redact-sample", "1"])
m2 = r2["manifest"] or {}
boxes = ((m2.get("redactions") or {}).get("boxes") or [])
add("T2 boxes found", len(boxes) >= 1, f"{len(boxes)} box(es)")
bad_json = [e for e in r2["events"] if e.get("event") == "_NON_JSON_"]
add("T2 NDJSON clean", not bad_json, f"{len(r2['events'])} events, {len(bad_json)} non-JSON")
if boxes:
    b = boxes[0]
    ins, _ = edge_energy(r2["out"], b["x"], b["y"], b["w"], b["h"])
    loc = board_boxes(r2["out"])
    add("T2 board visible", "plain" in loc or "nobody" in loc, f"found={list(loc)}")
    if "plain" in loc or "nobody" in loc:
        px, py, pw, ph = loc.get("plain") or loc.get("nobody")
        plain, _ = edge_energy(r2["out"], px, py, pw, ph)
        add("T2 box blurred", ins < max(0.8, plain * 0.5), f"inside={ins} vs plain-line={plain}")
        keep = ocr_region(r2["out"], px, py, pw, ph)
        add("T2 other text kept", "plain" in keep or "nobody" in keep, f"ocr={keep.strip()[:40]!r}")
    txt = ocr_region(r2["out"], b["x"], b["y"], b["w"], b["h"])
    add("T2 text unreadable", "hermes" not in txt and "secret" not in txt, f"ocr={txt.strip()[:40]!r}")

print("== T2b redact-text that matches nothing must warn", flush=True)
r2b = record("t2b_nomatch", ["-d", "3", "--redact-text", "zzqx-not-on-screen"])
m2b = (r2b["manifest"] or {}).get("redactions") or {}
add("T2b warning in manifest", bool(m2b.get("warning")), f"warning={str(m2b.get('warning'))[:50]}")
add("T2b warning event", any(e.get("event") == "redaction.warning" for e in r2b["events"]), "event emitted")

print("== T3 window capture", flush=True)
r3 = record("t3_window", ["--window-name", "Preview", "-d", "3"])
m3 = r3["manifest"] or {}
p3 = probe(r3["out"]) if os.path.exists(r3["out"]) else None
tgt = (m3.get("target") or {})
add("T3 window target", tgt.get("type") == "window", f"target={tgt}")
add("T3 window video", bool(p3), f"{p3['w']}x{p3['h']} dur={p3['dur']:.1f}" if p3 else "missing")

print("== T4 auto-zoom + redact-text together", flush=True)
r4 = record("t4_zoom_redact", ["-d", "4", "--auto-zoom", "2", "--redact-text", "hermes-e2e-secret",
                               "--redact-sample", "1"])
m4 = r4["manifest"] or {}
p4 = probe(r4["out"]) if os.path.exists(r4["out"]) else None
add("T4 output", bool(p4), f"dur={p4['dur']:.1f} {p4['w']}x{p4['h']}" if p4 else "missing")
add("T4 redactions kept", bool((m4.get("redactions") or {}).get("boxes")),
    f"boxes={len((m4.get('redactions') or {}).get('boxes') or [])}")
add("T4 cursor log kept", bool(m4.get("cursor_log")), f"cursor_log={m4.get('cursor_log')}")

print("== T5 auto-redact (email/card)", flush=True)
r5 = record("t5_auto_redact", ["-d", "3", "--auto-redact"])
m5 = r5["manifest"] or {}
red5 = m5.get("redactions") or {}
add("T5 sensitive boxes", (red5.get("static") or 0) >= 1, f"static={red5.get('static')}")
loc5 = board_boxes(r5["out"])
add("T5 board visible", bool(loc5), f"found={list(loc5)}")
add("T5 email not readable", "e2e.test" not in loc5, f"ocr lines={list(loc5)}")

print("== T6 static --redact region", flush=True)
loc1 = board_boxes(r1["out"]) if os.path.exists(r1["out"]) else {}
t6_key = next((k for k in ("hermes-e2e-secret", "secret", "plain", "nobody") if k in loc1), None)
if t6_key:
    sx, sy, sw, shh = loc1[t6_key]
    r6 = record("t6_region", ["-d", "3", "--redact", f"{sx},{sy},{sw},{shh}"])
    if os.path.exists(r6["out"]):
        ins, _ = edge_energy(r6["out"], sx, sy, sw, shh)
        ref, _ = edge_energy(r1["out"], sx, sy, sw, shh)
        add("T6 static blur", ins < max(0.8, ref * 0.5), f"inside={ins} vs unredacted={ref}")
else:
    add("T6 static blur", False, "board line not located")

print("== T7 --no-manifest", flush=True)
r7 = record("t7_nomanifest", ["-d", "2", "--no-manifest"])
add("T7 no json", not os.path.exists(r7["manifest_path"]), f"exists={os.path.exists(r7['manifest_path'])}")

print("== T8 --stop-file", flush=True)
r8 = record("t8_stopfile", [], stop_after=2.5)
p8 = probe(r8["out"]) if os.path.exists(r8["out"]) else None
ev = [e["event"] for e in r8["events"]]
add("T8 stop-file event", "capture.stop_file" in ev, f"events={ev}")
m8 = r8["manifest"] or {}
wall8 = ((m8.get("stopped_at") or 0) - (m8.get("started_at") or 0)) / 1000.0
add("T8 stopped on time", 2.0 < wall8 < 3.2, f"wall={wall8:.2f}s video={p8['dur'] if p8 else None:.2f}s")

print("== T9 sync anchor (manifest vs wall clock)", flush=True)
if m1 and p1:
    wall = (m1["stopped_at"] - m1["started_at"]) / 1000.0
    add("T9 anchor sane", abs(wall - p1["dur"]) < 1.0, f"wall={wall:.2f}s video={p1['dur']:.2f}s")

print("== T10 system audio (plain path)", flush=True)
import numpy as _np
def tone_check(path, expect_hz=880.0):
    wav = os.path.join(HERE, "tone_check.wav")
    sh(["ffmpeg", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", wav])
    if not os.path.exists(wav):
        return None, None
    import wave
    w = wave.open(wav)
    a = _np.frombuffer(w.readframes(w.getnframes()), dtype=_np.int16).astype(float)
    w.close()
    os.remove(wav)
    if a.size == 0 or not a.any():
        return None, None
    spec = _np.abs(_np.fft.rfft(a * _np.hanning(len(a))))
    freq = _np.fft.rfftfreq(len(a), 1 / 16000)
    win = 1600
    env = [_np.abs(a[i:i + win]).mean() for i in range(0, len(a) - win, win)]
    onset = next((i * 0.1 for i, x in enumerate(env) if x > 500), None)
    return float(freq[spec.argmax()]), onset


def make_tone():
    tone = os.path.join(HERE, "tone.wav")
    if not os.path.exists(tone):
        sh(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
            "-ar", "48000", tone])
    return tone


def record_with_tone(name, args, tone_at=1.5):
    make_tone()
    return record(name, args, tone_at=tone_at)


r10 = record_with_tone("t10_sysaudio", ["-d", "4", "--system-audio"])
streams = sh(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0",
              r10["out"]]).stdout.split()
add("T10 audio track present", "audio" in streams and "video" in streams, f"streams={streams}")
hz, onset = tone_check(r10["out"])
add("T10 tone captured", hz is not None and abs(hz - 880.0) < 10, f"peak={hz}Hz onset={onset}s")
add("T10 tone onset in sync", onset is not None and 1.0 <= onset <= 2.6,
    f"onset={onset}s (afplay fired 1.5s after capture start)")
add("T10 muxed event", any(e.get("event") == "audio.muxed" for e in r10["events"]),
    f"events={[e.get('event') for e in r10['events']]}")
m10 = r10["manifest"] or {}
add("T10 manifest audio flag", (m10.get("audio") or {}).get("system") is True, f"audio={m10.get('audio')}")
leftover = [f for f in os.listdir(OUT) if f.startswith(".sysaudio-")]
add("T10 sidecars cleaned", not leftover, f"leftover={leftover}")

print("== T11 system audio + auto-zoom + redact-text (post-processed path)", flush=True)
r11 = record_with_tone("t11_sysaudio_post", ["-d", "5", "--system-audio", "--auto-zoom", "2",
                       "--redact-text", "hermes-e2e-secret", "--redact-sample", "1"], tone_at=2.0)
hz11, on11 = tone_check(r11["out"])
add("T11 tone survives post", hz11 is not None and abs(hz11 - 880.0) < 10 and on11 is not None and on11 >= 1.0, f"peak={hz11}Hz onset={on11}s")
add("T11 redaction still applied", bool(((r11["manifest"] or {}).get("redactions") or {}).get("boxes")),
    "boxes present")

print("== T12 microphone (room mic hears the speakers)", flush=True)
r12 = record_with_tone("t12_mic", ["-d", "5", "--mic"], tone_at=1.5)
hz12, on12 = tone_check(r12["out"])
add("T12 mic tone heard", hz12 is not None and abs(hz12 - 880.0) < 10, f"peak={hz12}Hz onset={on12}s")
add("T12 manifest mic flag", ((r12["manifest"] or {}).get("audio") or {}).get("microphone") is True,
    f"audio={(r12['manifest'] or {}).get('audio')}")

print("== T13 microphone + system audio (two sidecars, one mixed track)", flush=True)
r13 = record_with_tone("t13_both", ["-d", "5", "--mic", "--system-audio"], tone_at=1.5)
streams13 = sh(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name",
                "-of", "csv=p=0", r13["out"]]).stdout.split()
hz13, on13 = tone_check(r13["out"])
a13 = (r13["manifest"] or {}).get("audio") or {}
add("T13 one mixed audio track", len(streams13) == 1, f"audio streams={streams13}")
add("T13 tone present", hz13 is not None and abs(hz13 - 880.0) < 10, f"peak={hz13}Hz onset={on13}s")
add("T13 manifest both", a13.get("system") is True and a13.get("microphone") is True, f"audio={a13}")

print()
print("== T14 MCP server (stdio) records with redact_text", flush=True)
focus_board()
mp = subprocess.Popen(["node", "cli/mcp.mjs"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                      stderr=subprocess.PIPE, text=True)
_n = [0]


def rpc(method, params=None):
    _n[0] += 1
    mp.stdin.write(json.dumps({"jsonrpc": "2.0", "id": _n[0], "method": method, "params": params or {}}) + "\n")
    mp.stdin.flush()
    return json.loads(mp.stdout.readline())


def mcall(name, args=None):
    res = rpc("tools/call", {"name": name, "arguments": args or {}})["result"]
    txt = res["content"][0]["text"]
    return res["isError"], (json.loads(txt) if txt[:1] in "{[" else txt)


try:
    info = rpc("initialize", {"protocolVersion": "2024-11-05"})["result"]
    tools = [x["name"] for x in rpc("tools/list")["result"]["tools"]]
    add("T14 handshake+tools", info["serverInfo"]["name"] == "vidcli" and len(tools) == 6, f"tools={tools}")
    mout = os.path.join(OUT, "t14_mcp.mp4")
    err, st = mcall("vidcli_start", {"output": mout, "overwrite": True, "redact_text": "hermes-e2e-secret"})
    add("T14 start", not err and st["id"].startswith("rec-"), f"id={st.get('id') if not err else st}")
    time.sleep(3.5)
    err, ss = mcall("vidcli_status", {"id": st["id"]})
    add("T14 status recording", not err and ss["state"] == "recording", f"state={ss.get('state')}")
    err, sp = mcall("vidcli_stop", {"id": st["id"]})
    mm = (sp.get("manifest") or {}) if not err else {}
    add("T14 stop returns manifest", not err and bool(mm.get("started_at")) and (mm.get("duration_s") or 0) > 2.5,
        f"duration_s={mm.get('duration_s')}")
    mb = ((mm.get("redactions") or {}).get("boxes") or [])
    add("T14 redaction via MCP", len(mb) >= 1, f"{len(mb)} box(es)")
    if mb:
        ins, _ = edge_energy(mout, mb[0]["x"], mb[0]["y"], mb[0]["w"], mb[0]["h"])
        add("T14 blur applied", ins < 1.0, f"inside={ins}")
    err2, msg = mcall("vidcli_start", {"output": mout})
    add("T14 refuses overwrite", err2 and "exists" in str(msg), str(msg)[:60])
    err3, msg3 = mcall("vidcli_start", {"output": "rel.mp4"})
    add("T14 refuses relative path", err3, str(msg3)[:60])
finally:
    mp.stdin.close()
    try:
        add("T14 server exits on close", mp.wait(timeout=10) == 0, "exit 0")
    except subprocess.TimeoutExpired:
        mp.kill()
        add("T14 server exits on close", False, "had to kill")

print()
print("== T15 compose (narration + captions + music + ending)", flush=True)
import re as _re
from PIL import Image as _Image
focus_board()
for i, txt in enumerate(["This is the first line.", "And this is the second line, a bit longer."]):
    aiff, wav = os.path.join(HERE, f"v{i}.aiff"), os.path.join(HERE, f"v{i}.wav")
    sh(["say", "-o", aiff, txt])
    sh(["ffmpeg", "-v", "error", "-y", "-i", aiff, "-ar", "48000", wav])
bed = os.path.join(HERE, "bed.wav")
sh(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-ar", "48000", bed])
rt = record("t15_take", ["-d", "6"])
t0 = (rt["manifest"] or {}).get("started_at")
lines_path = os.path.join(HERE, "lines.json")
json.dump({"lines": [
    {"wav": os.path.join(HERE, "v0.wav"), "ts": (t0 or 0) + 1500, "caption": "First line"},
    {"wav": os.path.join(HERE, "v1.wav"), "ts": (t0 or 0) + 4800, "caption": "Second line, longer caption"}]},
    open(lines_path, "w"))
cfinal = os.path.join(OUT, "t15_final.mp4")
rc = sh(["node", "cli/record.mjs", "compose", "--video", rt["out"], "--lines", lines_path, "-o", cfinal,
         "--music", bed])
add("T15 compose exit", rc.returncode == 0 and os.path.exists(cfinal), (rc.stderr or "")[-80:] or "ok")
if os.path.exists(cfinal):
    pc = probe(cfinal)
    add("T15 size + hold", bool(pc) and pc["w"] == 1920 and 8.8 < pc["dur"] < 9.6, f"{pc}")
    sil = sh(["ffmpeg", "-i", cfinal, "-af", "highpass=f=600,silencedetect=n=-38dB:d=0.25", "-f", "null", "-"]).stderr
    ons = [float(x) for x in _re.findall(r"silence_end: ([\d.]+)", sil)]
    add("T15 voice 1 on time", any(abs(o - 1.5) < 0.25 for o in ons), f"onsets={ons}")
    add("T15 voice 2 on time", any(abs(o - 4.8) < 0.25 for o in ons), f"onsets={ons}")

    def strip_white(tm):
        fp = os.path.join(HERE, "cf.png")
        sh(["ffmpeg", "-v", "error", "-y", "-ss", str(tm), "-i", cfinal, "-frames:v", "1", fp])
        a = _np.array(_Image.open(fp).convert("RGB"))
        os.remove(fp)
        return int((a[-70:].min(axis=2) > 200).sum())
    add("T15 caption shown", strip_white(2.0) > 300 and strip_white(5.5) > 300,
        f"white px {strip_white(2.0)} / {strip_white(5.5)}")
    add("T15 caption hidden between", strip_white(0.5) == 0 and strip_white(3.5) == 0, "strip empty outside lines")

    def fr(tm):
        fp = os.path.join(HERE, "cf.png")
        sh(["ffmpeg", "-v", "error", "-y", "-ss", str(tm), "-i", cfinal, "-frames:v", "1", fp])
        a = _np.array(_Image.open(fp).convert("RGB")).astype(int)
        os.remove(fp)
        return a[:-80]
    add("T15 last frame held", float(_np.abs(fr(6.3) - fr(7.0)).mean()) < 0.5, "frames identical before fade")
    add("T15 fades to black", int(fr(9.1).mean()) < 20, f"brightness={int(fr(9.1).mean())}")

print("== T16 MCP compose tool", flush=True)
mp2 = subprocess.Popen(["node", "cli/mcp.mjs"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, text=True)
try:
    mp2.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "vidcli_compose", "arguments": {
            "video": rt["out"], "output": os.path.join(OUT, "t16_mcp_final.mp4"), "overwrite": True,
            "lines": [{"wav": os.path.join(HERE, "v0.wav"), "ts": (t0 or 0) + 1500, "caption": "Via MCP"}]}}}) + "\n")
    mp2.stdin.flush()
    res = json.loads(mp2.stdout.readline())["result"]
    body = json.loads(res["content"][0]["text"])
    add("T16 compose via MCP", not res["isError"] and os.path.exists(os.path.join(OUT, "t16_mcp_final.mp4")),
        f"total_s={body.get('total_s') if isinstance(body, dict) else body}")
finally:
    mp2.stdin.close()
    mp2.wait(timeout=10)

print()
print()
fails = [r for r in results if not r[1]]
print(f"SUMMARY: {len(results) - len(fails)}/{len(results)} passed")
for n, ok, d in results:
    if not ok:
        print(f"  FAILED {n}: {d}")
sys.exit(1 if fails else 0)
