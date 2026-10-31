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
 * Options:
 *   -o, --output <path>     Output file (default: ./vidcli-<timestamp>.mp4)
 *   -d, --duration <sec>    Stop after N seconds (default: record until Ctrl+C)
 *   --display <id>          Display id to capture (default: primary)
 *   --fps <n>               Frame rate (default: 60)
 *   --system-audio          Capture system audio (macOS native helper)
 *   --mic                   Capture microphone (macOS native helper)
 *   --window <id>           Capture a window by id instead of a display
 *   -h, --help              Show help
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  redactText: null,
  redactSample: 2.0,
  stopFile: null,
  manifest: true,
  json: false,
  overwrite: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '-o' || a === '--output') opts.output = args[++i];
  else if (a === '-d' || a === '--duration') opts.duration = Number(args[++i]);
  else if (a === '--display') opts.display = args[++i];
  else if (a === '--window') opts.window = args[++i];
  else if (a === '--window-name') opts.windowName = args[++i];
  else if (a === '--fps') opts.fps = Number(args[++i]);
  else if (a === '--system-audio') opts.systemAudio = true;
  else if (a === '--mic') opts.mic = true;
  else if (a === '--zoom') opts.zoom = Number(args[++i]);
  else if (a === '--auto-zoom') opts.autoZoom = Number(args[++i]);
  else if (a === '--crop') opts.crop = args[++i];
  else if (a === '--redact') opts.redact = args[++i];
  else if (a === '--auto-redact') opts.autoRedact = true;
  else if (a === '--auto-redact-all') opts.autoRedactAll = true;
  else if (a === '--redact-text') opts.redactText = args[++i];
  else if (a === '--redact-sample') opts.redactSample = Number(args[++i]);
  else if (a === '--stop-file') opts.stopFile = args[++i];
  else if (a === '--no-manifest') opts.manifest = false;
  else if (a === '--overwrite') opts.overwrite = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--trim-silence') opts.trimSilence = true;
  else if (a === '--print-media') opts.printMedia = true;
  else if (a === '--open') opts.open = true;
  else if (a === '--keep-raw') opts.keepRaw = true;
  else if (a === 'record') {
    // allow `vidcli record ...`
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

if (opts.help) {
  console.log(`VidCLI recorder

Usage: vidcli record [options]  (or: node cli/record.mjs [options])

Options:
  -o, --output <path>     Output file (default: ./vidcli-<timestamp>.mp4)
  -d, --duration <sec>    Stop after N seconds (default: until Ctrl+C)
  --display <id>          Display id to capture (default: primary)
  --fps <n>               Frame rate (default: 60)
  --system-audio          Capture system audio (macOS)
  --mic                   Capture microphone (macOS)
  --window <id>           Capture a window by id instead of a display
  --window-name <name>    Resolve window by name (macOS)
  --redact <regions>      Blur regions "x,y,w,h" (semicolon for multiple)
  --redact-text <words>   Blur any OCR text containing these words (comma separated);
                          the box follows the text for as long as it is on screen
  --redact-sample <sec>   OCR sampling interval for redaction (default: 2)
  --stop-file <path>      Stop recording when this file appears
  --json                  NDJSON events on stdout (human logs go to stderr)
  --no-manifest           Do not write <output>.json
  --overwrite             Replace the output file if it already exists
  --auto-redact           Auto-detect sensitive text (emails, phones) and blur
  --auto-redact-all       Auto-detect and blur ALL text regions
  --trim-silence          Trim leading/trailing silence (requires audio)
  -h, --help              Show help
`);
  process.exit(0);
}

// Resolve --window-name to --window id
if (opts.windowName) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const helper = path.join(repoRoot, 'electron', 'native', 'bin',
    process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64', 'openscreen-window-list');
  try {
    const out = execFileSync(helper, { encoding: 'utf8' });
    const wins = JSON.parse(out);
    const q = opts.windowName.toLowerCase();
    const match = wins.find(w => (w.name || '').toLowerCase().includes(q) || (w.windowTitle || '').toLowerCase().includes(q));
    if (!match) { console.error(`No window matching "${opts.windowName}"`); process.exit(1); }
    opts.window = match.id.split(':')[1];
  } catch (e) {
    console.error('Failed to list windows:', e.message);
    process.exit(1);
  }
}
// --- machine-readable output and recording metadata -------------------------
const emit = (event, data = {}) => {
  if (opts.json) process.stdout.write(JSON.stringify({ event, ts: Date.now(), ...data }) + '\n');
};
if (opts.json) {
  // keep stdout clean for NDJSON; human-facing logs go to stderr
  console.log = (...a) => console.error(...a);
}
const meta = {
  tool: 'vidcli',
  argv: process.argv.slice(2),
  platform: process.platform,
  arch: process.arch,
  fps: opts.fps,
  started_at: null,
  stopped_at: null,
  target: null,
  output: null,
  raw: null,
  redactions: null,
  cursor_log: null,
  click_log: null,
};

const timestamp = Date.now();
const outputPath = opts.output
  ? path.resolve(opts.output)
  : path.resolve(process.cwd(), `vidcli-${timestamp}.mp4`);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
if (fs.existsSync(outputPath)) {
  if (!opts.overwrite) {
    console.error(`Output already exists: ${outputPath}`);
    console.error('Pass --overwrite to replace it, or choose another -o path.');
    process.exit(2);
  }
  fs.rmSync(outputPath, { force: true });
}

const needsPost = (opts.zoom && opts.zoom > 1) || !!opts.crop || (opts.autoZoom && opts.autoZoom > 1) || !!opts.redact || !!opts.redactText || opts.autoRedact || opts.autoRedactAll;
const capturePath = needsPost
  ? path.join(path.dirname(outputPath), `.raw-${timestamp}.mp4`)
  : outputPath;
meta.target = opts.window
  ? { type: 'window', id: Number(opts.window), name: opts.windowName || null }
  : { type: 'display', id: opts.display ? Number(opts.display) : 'primary' };
meta.raw = needsPost ? capturePath : null;
const cursorPath = path.join(path.dirname(outputPath), `.cursor-${timestamp}.jsonl`);
const clickPath = path.join(path.dirname(outputPath), `.clicks-${timestamp}.jsonl`);
const sysAudioPath = path.join(path.dirname(outputPath), `.sysaudio-${timestamp}.m4a`);
const micAudioPath = path.join(path.dirname(outputPath), `.mic-${timestamp}.m4a`);

function helperPath() {
  if (process.env.VIDCLI_HELPER || process.env.RECORDLY_HELPER) return process.env.VIDCLI_HELPER || process.env.RECORDLY_HELPER;
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    // resolve relative to this file's repo root
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const prebundled = path.join(repoRoot, 'electron', 'native', 'bin', arch, 'recordly-screencapturekit-helper');
    if (fs.existsSync(prebundled)) return prebundled;
    // userData-style compiled location
    const home = os.homedir();
    const userData = path.join(home, 'Library', 'Application Support', 'VidCLI', 'native-tools', 'recordly-screencapturekit-helper');
    if (fs.existsSync(userData)) return userData;
    return prebundled;
  }
  return null;
}

function ensureClickLogger() {
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), 'click-log.swift');
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
      console.error('Failed to compile click logger:', r.stderr?.toString());
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

function buildMacConfig() {
  const cfg = { fps: opts.fps, outputPath: capturePath, capturesSystemAudio: opts.systemAudio, capturesMicrophone: opts.mic };
  if (opts.systemAudio) cfg.systemAudioOutputPath = sysAudioPath;
  if (opts.mic) cfg.microphoneOutputPath = micAudioPath;
  if (opts.window) {
    cfg.windowId = Number(opts.window);
  } else if (opts.display) {
    cfg.displayId = Number(opts.display);
  } else {
    // default primary: leave displayId unset -> helper uses CGMainDisplayID()
  }
  return cfg;
}

function recordMac() {
  const hp = helperPath();
  if (!hp || !fs.existsSync(hp)) {
    console.error(`Native helper not found: ${hp}`);
    console.error('Build it with: npm run build:native-helpers (or set VIDCLI_HELPER)');
    process.exit(1);
  }
  const cfg = JSON.stringify(buildMacConfig());
  console.log(`Recording to ${capturePath}`);
  console.log('Press Ctrl+C to stop' + (opts.duration ? ` (or wait ${opts.duration}s)` : '') + '.');

  // Start cursor logger if auto-zoom requested
  let cursorProc = null;
  let clickProc = null;
  if (opts.autoZoom && opts.autoZoom > 1) {
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'cursor-log.py');
    cursorProc = spawn('python3', [script, cursorPath], { stdio: 'ignore' });
    meta.cursor_log = cursorPath;
    const clickBin = ensureClickLogger();
    if (clickBin) {
      clickProc = spawn(clickBin, [clickPath], { stdio: 'ignore' });
      meta.click_log = clickPath;
    }
  }

  const p = spawn(hp, [cfg], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let started = false;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { p.stdin.write('stop\n'); } catch {}
  };

  p.stdout.on('data', (d) => {
    const s = d.toString();
    buf += s;
    if (opts.json) process.stderr.write(s); else process.stdout.write(s);
    if (!started && buf.includes('Recording started')) {
      started = true;
      meta.started_at = Date.now();
      emit('capture.started', { output: capturePath, target: meta.target, fps: opts.fps });
      if (opts.duration && Number.isFinite(opts.duration) && opts.duration > 0) {
        setTimeout(stop, opts.duration * 1000);
      }
      if (opts.stopFile) {
        const timer = setInterval(() => {
          if (stopped) { clearInterval(timer); return; }
          if (fs.existsSync(opts.stopFile)) {
            clearInterval(timer);
            console.log(`Stop file appeared (${opts.stopFile}); stopping.`);
            emit('capture.stop_file', { path: opts.stopFile });
            stop();
          }
        }, 200);
        timer.unref?.();
      }
    }
    if (buf.includes('Recording stopped. Output path:')) {
      // done soon
    }
  });
  p.stderr.on('data', (d) => process.stderr.write(d));

  process.on('SIGINT', () => { console.log('\nStopping...'); stop(); });
  process.on('SIGTERM', () => stop());

  p.on('exit', (code) => {
    meta.stopped_at = Date.now();
    emit('capture.stopped', { code, path: capturePath });
    const m = buf.match(/Recording stopped\. Output path: (.+)/);
    const finalPath = m ? m[1].trim() : capturePath;
    if (cursorProc) { try { cursorProc.kill(); } catch {} }
    if (clickProc) { try { clickProc.kill(); } catch {} }
    if (code === 0) {
      console.log(`\nSaved: ${finalPath}`);
    } else {
      console.error(`\nRecording failed (exit ${code})`);
      process.exit(code ?? 1);
    }
    finish();
  });
}

function recordFfmpeg() {
  const ffmpeg = ffmpegPath();
  let inputArgs;
  if (process.platform === 'darwin') {
    inputArgs = ['-f', 'avfoundation', '-i', '1:none'];
  } else if (process.platform === 'linux') {
    inputArgs = ['-f', 'x11grab', '-i', process.env.DISPLAY || ':0.0'];
  } else if (process.platform === 'win32') {
    inputArgs = ['-f', 'gdigrab', '-i', 'desktop'];
  } else {
    console.error('Unsupported platform for ffmpeg fallback: ' + process.platform);
    process.exit(1);
  }
  const args = [...inputArgs, '-r', String(opts.fps), capturePath];
  console.log(`Recording to ${capturePath} via ffmpeg (Ctrl+C to stop)`);
  const p = spawn(ffmpeg, args, { stdio: 'inherit' });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { p.stdin.write('q'); } catch {}
  };
  if (opts.duration) setTimeout(stop, opts.duration * 1000);
  process.on('SIGINT', () => { console.log('\nStopping...'); stop(); });
  process.on('SIGTERM', () => stop());
  p.on('exit', (code) => {
    console.log(`\nSaved: ${capturePath}`);
    if (code && code !== 0) process.exit(code);
    finish();
  });
}

// Children that print progress must go to stderr when stdout carries NDJSON.
function childStdio() {
  return opts.json ? ['inherit', 'pipe', 'pipe'] : 'inherit';
}

function runPostProcess() {
  const useAutozoom = (opts.autoZoom && opts.autoZoom > 1) || !!opts.redact || !!opts.redactText || opts.autoRedact || opts.autoRedactAll;
  if (useAutozoom) {
    return new Promise((resolve, reject) => {
      const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'autozoom.py');
      const zoomVal = (opts.autoZoom && opts.autoZoom > 1) ? opts.autoZoom : (opts.zoom && opts.zoom > 1 ? opts.zoom : 1);
      const args = [script, capturePath, cursorPath, clickPath, String(zoomVal), outputPath];
      if (opts.redact) args.push(opts.redact); else args.push('');
      args.push(opts.autoRedactAll ? 'all' : (opts.autoRedact ? 'sensitive' : ''));
      args.push(opts.redactText || '');
      args.push(String(opts.redactSample || 2));
      const p = spawn('python3', args, { stdio: childStdio() });
      if (opts.json) {
        p.stdout.on('data', (d) => process.stderr.write(d));
        p.stderr.on('data', (d) => process.stderr.write(d));
      }
      p.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`autozoom failed (exit ${code})`));
      });
    });
  }
  return new Promise((resolve, reject) => {
    const ffmpeg = ffmpegPath();
    const filters = [];
    if (opts.crop) {
      const [x, y, w, h] = opts.crop.split(',').map((n) => n.trim());
      filters.push(`crop=${w}:${h}:${x}:${y}`);
    }
    if (opts.zoom && opts.zoom > 1) {
      const z = opts.zoom;
      filters.push(`scale=iw*${z}:ih*${z},crop=iw/${z}:ih/${z}:(iw-iw/${z})/2:(ih-ih/${z})/2`);
    }
    const args = ['-y', '-i', capturePath];
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-c:a', 'copy', outputPath);
    console.log(`Post-processing -> ${outputPath}`);
    const p = spawn(ffmpeg, args, { stdio: childStdio() });
    if (opts.json) {
      p.stdout.on('data', (d) => process.stderr.write(d));
      p.stderr.on('data', (d) => process.stderr.write(d));
    }
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg post-process failed (exit ${code})`));
    });
  });
}

function trimSilenceFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = ffmpegPath();
    // check for audio stream
    const probeA = spawnSync(ffmpeg, ['-i', inputPath], { encoding: 'utf8' });
    if (!/Audio:/i.test(probeA.stderr || '')) { resolve(); return; } // no audio -> skip
    // detect silence
    const r = spawnSync(ffmpeg, ['-i', inputPath, '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 10*1024*1024 });
    const out = (r.stderr || '') + (r.stdout || '');
    const starts = [...out.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
    const ends = [...out.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
    // leading silence: if first silence starts at ~0
    let start = 0;
    let doTrim = false;
    if (starts.length && starts[0] < 0.1) { start = ends[0] || 0; doTrim = true; }
    // trailing silence: if last silence end ~ duration
    let probe = spawnSync(ffmpeg, ['-i', inputPath], { encoding: 'utf8' });
    const durMatch = (probe.stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    let duration = 0;
    if (durMatch) duration = parseInt(durMatch[1])*3600 + parseInt(durMatch[2])*60 + parseFloat(durMatch[3]);
    let end = duration;
    if (starts.length && ends.length) {
      const lastStart = starts[starts.length-1];
      const lastEnd = ends[ends.length-1];
      if (lastEnd >= duration - 0.5) { end = lastStart; doTrim = true; }
    }
    if (!doTrim || end - start < 1) { resolve(); return; } // nothing to trim
    // trim
    const tmp = outputPath + '.trimmed.mp4';
    const rr = spawnSync(ffmpeg, ['-y', '-ss', String(start), '-to', String(end), '-i', inputPath,
      '-c', 'copy', tmp], { stdio: 'pipe' });
    if (rr.status === 0 && fs.existsSync(tmp)) {
      fs.rmSync(inputPath, { force: true });
      fs.renameSync(tmp, outputPath);
      console.log(`Trimmed silence: ${start.toFixed(2)}s -> ${end.toFixed(2)}s`);
      resolve();
    } else {
      console.error('Trim failed:', rr.stderr?.toString?.() || '');
      reject(new Error('trim failed'));
    }
  });
}

function ffprobePath() {
  for (const c of ['ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return 'ffprobe';
}

function probeDuration(file) {
  try {
    const r = spawnSync(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', file], { encoding: 'utf8' });
    return parseFloat((r.stdout || '').trim()) || null;
  } catch { return null; }
}

function writeManifest() {
  if (!opts.manifest) return null;
  const manifestPath = outputPath.replace(/\.mp4$/i, '') + '.json';
  meta.output = outputPath;
  meta.duration_s = probeDuration(outputPath);
  meta.requested_duration_s = opts.duration || null;
  const cursorKept = fs.existsSync(cursorPath);
  const clickKept = fs.existsSync(clickPath);
  if (cursorKept) meta.cursor_log = cursorPath;
  if (clickKept) meta.click_log = clickPath;
  meta.telemetry_deleted = !opts.keepRaw && (!!meta.cursor_log || !!meta.click_log);
  const redFile = outputPath + '.redactions.json';
  if (fs.existsSync(redFile)) {
    try { meta.redactions = JSON.parse(fs.readFileSync(redFile, 'utf8')); } catch { meta.redactions = null; }
  } else if (opts.redactText || opts.autoRedact || opts.autoRedactAll || opts.redact) {
    meta.redactions = { requested: { text: opts.redactText || null, auto: opts.autoRedactAll ? 'all' : (opts.autoRedact ? 'sensitive' : null), regions: opts.redact || null } };
  }
  try {
    fs.writeFileSync(manifestPath, JSON.stringify(meta, null, 1));
    emit('manifest.written', { path: manifestPath });
    return manifestPath;
  } catch (e) {
    console.error('Failed to write manifest:', e.message);
    return null;
  }
}

// The native helper writes system audio and microphone to separate .m4a files.
// Merge whatever was captured into the final MP4 (mixed to one track when both exist).
function muxAudioSidecars() {
  const have = [sysAudioPath, micAudioPath].filter((f) => fs.existsSync(f) && fs.statSync(f).size > 1024);
  meta.audio = { system: have.includes(sysAudioPath), microphone: have.includes(micAudioPath) };
  if (!have.length) {
    // Microphone-only takes are written inline by the helper: report them from the file itself.
    if (opts.mic && !opts.systemAudio && fs.existsSync(outputPath)) {
      const pr = spawnSync(ffprobePath(), ['-v', 'error', '-select_streams', 'a', '-show_entries',
        'stream=codec_name', '-of', 'csv=p=0', outputPath], { encoding: 'utf8' });
      if ((pr.stdout || '').trim()) meta.audio.microphone = true;
    }
    return;
  }
  if (!fs.existsSync(outputPath)) return;
  const tmp = outputPath + '.mux.mp4';
  const inputs = ['-i', outputPath, ...have.flatMap((f) => ['-i', f])];
  const args = ['-y', '-v', 'error', ...inputs, '-map', '0:v:0'];
  if (have.length === 2) {
    args.push('-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]', '-map', '[a]');
  } else {
    args.push('-map', '1:a:0');
  }
  args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', tmp);
  const r = spawnSync(ffmpegPath(), args, { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(tmp)) {
    fs.renameSync(tmp, outputPath);
    console.log(`Muxed audio: ${meta.audio.system ? 'system ' : ''}${meta.audio.microphone ? 'microphone' : ''}`.trim());
    emit('audio.muxed', meta.audio);
  } else {
    console.error('Audio mux failed:', (r.stderr || '').slice(0, 200));
    meta.audio.error = 'mux_failed';
  }
  if (!opts.keepRaw) for (const f of have) fs.rmSync(f, { force: true });
}

function finish() {
  if (needsPost) {
    runPostProcess()
      .then(() => {
        muxAudioSidecars();
        if (!opts.keepRaw) fs.rmSync(capturePath, { force: true });
        if (!opts.keepRaw) {
          fs.rmSync(cursorPath, { force: true });
          fs.rmSync(clickPath, { force: true });
        }
        if (opts.trimSilence) return trimSilenceFile(outputPath, outputPath);
      })
      .then(() => {
        console.log(`Final: ${outputPath}`);
        const manifest = writeManifest();
        emit('finished', { output: outputPath, manifest, duration_s: meta.duration_s });
        if (opts.printMedia) console.log(`MEDIA:${outputPath}`);
        if (opts.open) spawn('open', [outputPath], { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
      })
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
  } else {
    muxAudioSidecars();
    if (opts.trimSilence) {
      trimSilenceFile(outputPath, outputPath).then(() => {
        console.log(`Final: ${outputPath}`);
        const manifest = writeManifest();
        emit('finished', { output: outputPath, manifest, duration_s: meta.duration_s });
        if (opts.printMedia) console.log(`MEDIA:${outputPath}`);
        if (opts.open) spawn('open', [outputPath], { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
      }).catch((e) => { console.error(e.message); process.exit(1); });
    } else {
      console.log(`Final: ${outputPath}`);
      const manifest = writeManifest();
      emit('finished', { output: outputPath, manifest, duration_s: meta.duration_s });
      if (opts.printMedia) console.log(`MEDIA:${outputPath}`);
      if (opts.open) spawn('open', [outputPath], { detached: true, stdio: 'ignore' }).unref();
      process.exit(0);
    }
  }
}

if (process.platform === 'darwin') {
  recordMac();
} else {
  recordFfmpeg();
}
