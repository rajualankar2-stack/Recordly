#!/usr/bin/env node
/**
 * VidCLI recorder.
 *
 * Records the screen to a video file without the Electron UI.
 *
 * Usage:
 *   vidcli record [options]
 *   node cli/record.mjs [options]
 *
 * Run with --help for the full option list.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: pathname keeps %20 etc., which breaks checkouts under "My Projects/".
const cliDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(cliDir, '..');
const macBinDir = path.join(repoRoot, 'electron', 'native', 'bin',
  process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64');

const HELP = `VidCLI recorder

Usage: vidcli record [options]  (or: node cli/record.mjs [options])

Capture:
  -o, --output <path>     Output file (default: ./vidcli-<timestamp>.mp4)
  -d, --duration <sec>    Stop after N seconds (default: until Ctrl+C)
  --display <id>          Display id to capture (default: primary)
  --window <id>           Capture a window by id instead of a display (macOS)
  --window-name <name>    Capture the first window whose app/title contains <name> (macOS)
  --fps <n>               Frame rate (default: 60; the macOS helper never records below 60)
  --system-audio          Capture system audio (macOS)
  --mic                   Capture microphone (macOS)

Post-processing:
  --zoom <factor>         Static center zoom, e.g. 2 (ignored with --auto-zoom)
  --auto-zoom <factor>    Cursor-following zoom with click ripples, e.g. 2.5 (macOS)
  --crop <x,y,w,h>        Crop to a region, in video pixels
  --redact <regions>      Blur regions "x,y,w,h" in video pixels (";" between regions)
  --auto-redact           OCR and blur emails, phone and card numbers (needs tesseract)
  --auto-redact-all       OCR and blur all detected text (needs tesseract)
                          OCR samples the first, middle and last frames only.
  --trim-silence          Trim leading/trailing silence (needs an audio track)
  --keep-raw              Keep the unprocessed capture and cursor/click telemetry

Output:
  --open                  Open the final file when done
  --print-media           Print "MEDIA:<path>" once the final file is written
  -h, --help              Show help
`;

const args = process.argv.slice(2);
const opts = {
  output: null,
  duration: null,
  display: null,
  window: null,
  windowName: null,
  fps: 60,
  systemAudio: false,
  mic: false,
  zoom: null,
  crop: null,
  open: false,
  autoZoom: null,
  keepRaw: false,
  redact: null,
  autoRedact: false,
  autoRedactAll: false,
  trimSilence: false,
  printMedia: false,
};

function usageError(msg) {
  console.error(`${msg}\nRun with --help for usage.`);
  process.exit(2);
}

function requireValue(flag, v) {
  if (v === undefined) usageError(`${flag} needs a value`);
  return v;
}

function positiveNumber(flag, v, { integer = false } = {}) {
  const n = Number(requireValue(flag, v));
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    usageError(`${flag} must be a positive ${integer ? 'whole number' : 'number'}, got "${v}"`);
  }
  return n;
}

function numericId(flag, v) {
  if (!/^\d+$/.test(requireValue(flag, v))) usageError(`${flag} must be a numeric id, got "${v}"`);
  return v;
}

// Validated up front so a typo fails now, not after the recording when post-processing runs.
function rects(flag, v, { multiple }) {
  const parts = requireValue(flag, v).split(';').map((s) => s.replace(/\s+/g, '')).filter(Boolean);
  const ok = parts.length > 0 && (multiple || parts.length === 1)
    && parts.every((s) => /^\d+,\d+,\d+,\d+$/.test(s));
  if (!ok) usageError(`${flag} expects ${multiple ? '"x,y,w,h[;x,y,w,h...]"' : '"x,y,w,h"'}, got "${v}"`);
  return parts.join(';');
}

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '-o' || a === '--output') opts.output = requireValue(a, args[++i]);
  else if (a === '-d' || a === '--duration') opts.duration = positiveNumber(a, args[++i]);
  else if (a === '--display') opts.display = numericId(a, args[++i]);
  else if (a === '--window') opts.window = numericId(a, args[++i]);
  else if (a === '--window-name') opts.windowName = requireValue(a, args[++i]);
  else if (a === '--fps') opts.fps = positiveNumber(a, args[++i], { integer: true });
  else if (a === '--system-audio') opts.systemAudio = true;
  else if (a === '--mic') opts.mic = true;
  else if (a === '--zoom') opts.zoom = positiveNumber(a, args[++i]);
  else if (a === '--auto-zoom') opts.autoZoom = positiveNumber(a, args[++i]);
  else if (a === '--crop') opts.crop = rects(a, args[++i], { multiple: false });
  else if (a === '--redact') opts.redact = rects(a, args[++i], { multiple: true });
  else if (a === '--auto-redact') opts.autoRedact = true;
  else if (a === '--auto-redact-all') opts.autoRedactAll = true;
  else if (a === '--trim-silence') opts.trimSilence = true;
  else if (a === '--print-media') opts.printMedia = true;
  else if (a === '--open') opts.open = true;
  else if (a === '--keep-raw') opts.keepRaw = true;
  else if (a === 'record') {
    // allow `vidcli record ...`
  } else {
    usageError(`Unknown argument: ${a}`);
  }
}

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

let windowListCache = null;
function listWindows() {
  if (windowListCache) return windowListCache;
  // recordly-window-list ships for both arches; openscreen-window-list is the legacy arm64-only name.
  const helper = ['recordly-window-list', 'openscreen-window-list']
    .map((name) => path.join(macBinDir, name))
    .find((p) => fs.existsSync(p));
  if (!helper) throw new Error(`window list helper not found in ${macBinDir}`);
  windowListCache = JSON.parse(execFileSync(helper, { encoding: 'utf8' }));
  return windowListCache;
}

// Resolve --window-name to --window id
if (opts.windowName) {
  try {
    const q = opts.windowName.toLowerCase();
    const match = listWindows().find((w) => (w.name || '').toLowerCase().includes(q) || (w.windowTitle || '').toLowerCase().includes(q));
    if (!match) { console.error(`No window matching "${opts.windowName}"`); process.exit(1); }
    opts.window = match.id.split(':')[1];
  } catch (e) {
    console.error('Failed to list windows:', e.message);
    process.exit(1);
  }
}

if (opts.zoom > 1 && opts.autoZoom > 1) console.error('Note: --zoom is ignored when --auto-zoom is set.');

const timestamp = Date.now();
const outputPath = opts.output
  ? path.resolve(opts.output)
  : path.resolve(process.cwd(), `vidcli-${timestamp}.mp4`);
const workDir = path.dirname(outputPath);

fs.mkdirSync(workDir, { recursive: true });

const autoZoomOn = opts.autoZoom > 1;
const needsPost = opts.zoom > 1 || !!opts.crop || autoZoomOn || !!opts.redact || opts.autoRedact || opts.autoRedactAll;
// Always capture to a scratch file: a failed capture never clobbers an existing --output, and the
// macOS helper (AVAssetWriter) refuses to write over an existing file.
const capturePath = path.join(workDir, `.raw-${timestamp}.mp4`);
const cursorPath = path.join(workDir, `.cursor-${timestamp}.jsonl`);
const clickPath = path.join(workDir, `.clicks-${timestamp}.jsonl`);
const systemAudioPath = path.join(workDir, `.system-${timestamp}.m4a`);
const micAudioPath = path.join(workDir, `.mic-${timestamp}.m4a`);

function helperPath() {
  if (process.env.VIDCLI_HELPER || process.env.RECORDLY_HELPER) return process.env.VIDCLI_HELPER || process.env.RECORDLY_HELPER;
  if (process.platform === 'darwin') {
    const prebundled = path.join(macBinDir, 'recordly-screencapturekit-helper');
    if (fs.existsSync(prebundled)) return prebundled;
    // Where the Electron app compiles it. Its userData dir follows productName, which is still "Recordly".
    const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
    for (const appName of ['Recordly', 'VidCLI']) {
      const compiled = path.join(appSupport, appName, 'native-tools', 'recordly-screencapturekit-helper');
      if (fs.existsSync(compiled)) return compiled;
    }
    return prebundled;
  }
  return null;
}

function ensureClickLogger() {
  const src = path.join(cliDir, 'click-log.swift');
  const binDir = path.join(os.homedir(), '.cache', 'vidcli-cli');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'click-log');
  let needCompile = !fs.existsSync(bin);
  if (!needCompile) {
    try {
      const s = fs.statSync(src); const b = fs.statSync(bin);
      if (s.mtimeMs > b.mtimeMs) needCompile = true;
    } catch { needCompile = true; }
  }
  if (needCompile) {
    const r = spawnSync('swiftc', ['-O', src, '-o', bin], { stdio: 'pipe' });
    if (r.status !== 0) {
      console.error('Failed to compile click logger:', r.error?.message || r.stderr?.toString());
      return null;
    }
  }
  return bin;
}

function ffmpegPath() {
  const candidates = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return 'ffmpeg';
}

// The cursor logger records the captured area in global points so autozoom.py can map
// cursor/click positions into video pixels.
function cursorRegionArgs() {
  if (!opts.window) return opts.display ? ['--display', opts.display] : [];
  try {
    const w = listWindows().find((win) => win.id.split(':')[1] === opts.window);
    if (w) return ['--region', [w.x, w.y, w.width, w.height].join(',')];
  } catch {
    // fall through to the warning below
  }
  console.error('Warning: could not look up the window bounds; auto-zoom may be offset.');
  return [];
}

function buildMacConfig() {
  const cfg = { fps: opts.fps, outputPath: capturePath, capturesSystemAudio: opts.systemAudio, capturesMicrophone: opts.mic };
  // The helper refuses system audio without a sidecar path. The MP4's own audio track carries the
  // system audio; with --mic too, the mic only goes to its sidecar (mixed back in after capture).
  if (opts.systemAudio) {
    cfg.systemAudioOutputPath = systemAudioPath;
    if (opts.mic) cfg.microphoneOutputPath = micAudioPath;
  }
  if (opts.window) {
    cfg.windowId = Number(opts.window);
  } else if (opts.display) {
    cfg.displayId = Number(opts.display);
  } else {
    // default primary: leave displayId unset -> helper uses CGMainDisplayID()
  }
  return cfg;
}

function mixMicIntoCapture() {
  if (opts.systemAudio && !opts.keepRaw) fs.rmSync(systemAudioPath, { force: true });
  if (!(opts.systemAudio && opts.mic) || !fs.existsSync(micAudioPath)) return;
  const mixed = path.join(workDir, `.mixed-${timestamp}.mp4`);
  const r = spawnSync(ffmpegPath(), ['-y', '-hide_banner', '-loglevel', 'error', '-i', capturePath, '-i', micAudioPath,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', mixed], { stdio: 'inherit' });
  if (r.status === 0) {
    fs.renameSync(mixed, capturePath);
    if (!opts.keepRaw) fs.rmSync(micAudioPath, { force: true });
  } else {
    fs.rmSync(mixed, { force: true });
    console.error(`Could not mix the microphone into the video; it is kept at ${micAudioPath}`);
  }
}

function recordMac() {
  const hp = helperPath();
  if (!hp || !fs.existsSync(hp)) {
    console.error(`Native helper not found: ${hp}`);
    console.error('Build it with: npm run build:native-helpers (or set VIDCLI_HELPER)');
    process.exit(1);
  }

  // Prepared before capture starts: a first-run swiftc build takes seconds.
  const clickBin = autoZoomOn ? ensureClickLogger() : null;
  const regionArgs = autoZoomOn ? cursorRegionArgs() : [];

  const cfg = JSON.stringify(buildMacConfig());
  console.log(`Recording to ${capturePath}`);
  console.log('Press Ctrl+C to stop' + (opts.duration ? ` (or wait ${opts.duration}s)` : '') + '.');

  // Cursor/click loggers time-stamp from their own start, so they start with the first frame.
  let cursorProc = null;
  let clickProc = null;
  const startTelemetry = () => {
    if (!autoZoomOn) return;
    cursorProc = spawn('python3', [path.join(cliDir, 'cursor-log.py'), cursorPath, ...regionArgs], { stdio: 'ignore' });
    cursorProc.on('error', (e) => console.error('Cursor logger failed:', e.message));
    if (clickBin) {
      clickProc = spawn(clickBin, [clickPath], { stdio: 'ignore' });
      clickProc.on('error', (e) => console.error('Click logger failed:', e.message));
    }
  };

  // Detached: Ctrl+C signals the terminal's whole process group, and the helper has no SIGINT
  // handler, so it would die before finalizing the MP4. We send it "stop" on stdin instead.
  const p = spawn(hp, [cfg], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let buf = '';
  let started = false;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    p.stdin.write('stop\n');
  };

  p.on('error', (e) => {
    console.error(`Failed to start native helper: ${e.message}`);
    process.exit(1);
  });
  p.stdin.on('error', () => {
    // helper already exited; the exit handler reports it
  });
  p.stdout.on('data', (d) => {
    const s = d.toString();
    buf += s;
    process.stdout.write(s);
    if (!started && buf.includes('Recording started')) {
      started = true;
      startTelemetry();
      if (opts.duration) setTimeout(stop, opts.duration * 1000);
    }
  });
  p.stderr.on('data', (d) => process.stderr.write(d));

  process.on('SIGINT', () => { console.log('\nStopping...'); stop(); });
  process.on('SIGTERM', () => stop());

  // 'close', not 'exit': stdout must be drained before matching the final output line.
  p.on('close', (code) => {
    cursorProc?.kill();
    clickProc?.kill();
    if (code !== 0) {
      console.error(`\nRecording failed (exit ${code})`);
      process.exit(code || 1);
    }
    const m = buf.match(/Recording stopped\. Output path: (.+)/);
    console.log(`\nSaved: ${m ? m[1].trim() : capturePath}`);
    mixMicIntoCapture();
    finish();
  });
}

function recordFfmpeg() {
  const ffmpeg = ffmpegPath();
  // -framerate is the grab rate; -r after the input would only duplicate frames of a 30 fps grab.
  const rate = ['-framerate', String(opts.fps)];
  let inputArgs;
  if (process.platform === 'linux') {
    inputArgs = ['-f', 'x11grab', ...rate, '-i', process.env.DISPLAY || ':0.0'];
  } else if (process.platform === 'win32') {
    inputArgs = ['-f', 'gdigrab', ...rate, '-i', 'desktop'];
  } else {
    console.error('Unsupported platform for ffmpeg fallback: ' + process.platform);
    process.exit(1);
  }
  const durationArgs = opts.duration ? ['-t', String(opts.duration)] : [];
  // Screen grabs are RGB; without yuv420p libx264 writes 4:4:4, which most players can't decode.
  const args = [...inputArgs, ...durationArgs, '-pix_fmt', 'yuv420p', capturePath];
  console.log(`Recording to ${capturePath} via ffmpeg (Ctrl+C to stop)`);
  // stdin is piped so "q" can stop ffmpeg cleanly.
  const p = spawn(ffmpeg, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    p.stdin.write('q');
  };
  p.on('error', (e) => {
    console.error(`Failed to start ffmpeg: ${e.message}`);
    process.exit(1);
  });
  p.stdin.on('error', () => {
    // ffmpeg already exited; the exit handler reports it
  });
  process.on('SIGINT', () => { console.log('\nStopping...'); stop(); });
  process.on('SIGTERM', () => stop());
  p.on('exit', (code) => {
    // Ctrl+C reaches ffmpeg too; it still finalizes the file but exits 255.
    if (code !== 0 && !(stopped && code === 255)) {
      console.error(`\nRecording failed (exit ${code})`);
      process.exit(code || 1);
    }
    console.log(`\nSaved: ${capturePath}`);
    finish();
  });
}

function run(cmd, cmdArgs, label) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit' });
    p.on('error', (e) => reject(new Error(`${label} failed to start: ${e.message}`)));
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))));
  });
}

async function runPostProcess() {
  const useAutozoom = autoZoomOn || !!opts.redact || opts.autoRedact || opts.autoRedactAll;
  const staticZoom = !autoZoomOn && opts.zoom > 1;
  const useFfmpeg = !!opts.crop || staticZoom;
  // Redaction regions and cursor telemetry are in raw-capture coordinates, so autozoom.py runs
  // first and crop/static zoom are applied to its output.
  const redactedPath = path.join(workDir, `.redacted-${timestamp}.mp4`);
  let src = capturePath;
  try {
    if (useAutozoom) {
      const dst = useFfmpeg ? redactedPath : outputPath;
      await run('python3', [
        path.join(cliDir, 'autozoom.py'), src, cursorPath, clickPath,
        String(autoZoomOn ? opts.autoZoom : 1), dst, opts.redact || '',
        opts.autoRedactAll ? 'all' : (opts.autoRedact ? 'sensitive' : ''),
      ], 'autozoom');
      src = dst;
    }
    if (useFfmpeg) {
      const filters = [];
      if (opts.crop) {
        const [x, y, w, h] = opts.crop.split(',');
        filters.push(`crop=${w}:${h}:${x}:${y}`);
      }
      if (staticZoom) {
        const z = opts.zoom;
        filters.push(`scale=iw*${z}:ih*${z},crop=iw/${z}:ih/${z}:(iw-iw/${z})/2:(ih-ih/${z})/2`);
      }
      console.log(`Post-processing -> ${outputPath}`);
      await run(ffmpegPath(), ['-y', '-i', src, '-vf', filters.join(','), '-c:a', 'copy', outputPath], 'ffmpeg post-process');
    }
  } finally {
    fs.rmSync(redactedPath, { force: true });
  }
}

function trimSilence(file) {
  const ffmpeg = ffmpegPath();
  const info = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '';
  if (!/Audio:/.test(info)) {
    console.log('No audio track; skipping --trim-silence');
    return;
  }
  const durMatch = info.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : 0;
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const log = r.stderr || '';
  const starts = [...log.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  let start = 0;
  let end = duration;
  // leading silence: the first silence starts at ~0
  if (starts.length && starts[0] < 0.1 && ends.length) start = ends[0];
  // trailing silence: the last silence runs to the end. Some ffmpeg builds never print a
  // silence_end for it, which leaves one more start than end.
  if (starts.length > ends.length || (ends.length && ends[ends.length - 1] >= duration - 0.5)) {
    end = starts[starts.length - 1];
  }
  if ((start <= 0 && end >= duration) || end - start < 1) return; // nothing to trim
  const tmp = file + '.trimmed.mp4';
  const rr = spawnSync(ffmpeg, ['-y', '-ss', String(start), '-to', String(end), '-i', file, '-c', 'copy', tmp], { stdio: 'pipe' });
  if (rr.status !== 0 || !fs.existsSync(tmp)) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Trim failed: ${rr.stderr?.toString() || rr.error?.message || ''}`);
  }
  fs.renameSync(tmp, file);
  console.log(`Trimmed silence: ${start.toFixed(2)}s -> ${end.toFixed(2)}s`);
}

function openFile(file) {
  const [cmd, ...cmdArgs] = process.platform === 'darwin' ? ['open']
    : process.platform === 'win32' ? ['cmd', '/c', 'start', ''] : ['xdg-open'];
  spawn(cmd, [...cmdArgs, file], { detached: true, stdio: 'ignore' }).unref();
}

async function finish() {
  try {
    if (needsPost) {
      await runPostProcess();
      if (!opts.keepRaw) {
        for (const f of [capturePath, cursorPath, clickPath]) fs.rmSync(f, { force: true });
      }
    } else {
      fs.renameSync(capturePath, outputPath);
    }
    if (opts.trimSilence) trimSilence(outputPath);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log(`Final: ${outputPath}`);
  if (opts.printMedia) console.log(`MEDIA:${outputPath}`);
  if (opts.open) openFile(outputPath);
  process.exit(0);
}

if (process.platform === 'darwin') {
  recordMac();
} else {
  recordFfmpeg();
}
