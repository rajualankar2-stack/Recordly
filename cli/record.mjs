#!/usr/bin/env node
/**
 * Recordly CLI recorder.
 *
 * Records the screen to a video file without the Electron UI.
 *
 * Usage:
 *   recordly record [options]
 *   node cli/record.mjs [options]
 *
 * Options:
 *   -o, --output <path>     Output file (default: ./recordly-<timestamp>.mp4)
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
  else if (a === '--trim-silence') opts.trimSilence = true;
  else if (a === '--print-media') opts.printMedia = true;
  else if (a === '--open') opts.open = true;
  else if (a === '--keep-raw') opts.keepRaw = true;
  else if (a === 'record') {
    // allow `recordly record ...`
  } else {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

if (opts.help) {
  console.log(`Recordly CLI recorder

Usage: recordly record [options]  (or: node cli/record.mjs [options])

Options:
  -o, --output <path>     Output file (default: ./recordly-<timestamp>.mp4)
  -d, --duration <sec>    Stop after N seconds (default: until Ctrl+C)
  --display <id>          Display id to capture (default: primary)
  --fps <n>               Frame rate (default: 60)
  --system-audio          Capture system audio (macOS)
  --mic                   Capture microphone (macOS)
  --window <id>           Capture a window by id instead of a display
  --window-name <name>    Resolve window by name (macOS)
  --redact <regions>      Blur regions "x,y,w,h" (semicolon for multiple)
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
const timestamp = Date.now();
const outputPath = opts.output
  ? path.resolve(opts.output)
  : path.resolve(process.cwd(), `recordly-${timestamp}.mp4`);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const needsPost = (opts.zoom && opts.zoom > 1) || !!opts.crop || (opts.autoZoom && opts.autoZoom > 1) || !!opts.redact || opts.autoRedact || opts.autoRedactAll;
const capturePath = needsPost
  ? path.join(path.dirname(outputPath), `.raw-${timestamp}.mp4`)
  : outputPath;
const cursorPath = path.join(path.dirname(outputPath), `.cursor-${timestamp}.jsonl`);
const clickPath = path.join(path.dirname(outputPath), `.clicks-${timestamp}.jsonl`);

function helperPath() {
  if (process.env.RECORDLY_HELPER) return process.env.RECORDLY_HELPER;
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    // resolve relative to this file's repo root
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const prebundled = path.join(repoRoot, 'electron', 'native', 'bin', arch, 'recordly-screencapturekit-helper');
    if (fs.existsSync(prebundled)) return prebundled;
    // userData-style compiled location
    const home = os.homedir();
    const userData = path.join(home, 'Library', 'Application Support', 'Recordly', 'native-tools', 'recordly-screencapturekit-helper');
    if (fs.existsSync(userData)) return userData;
    return prebundled;
  }
  return null;
}

function ensureClickLogger() {
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), 'click-log.swift');
  const binDir = path.join(os.homedir(), '.cache', 'recordly-cli');
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
    console.error('Build it with: npm run build:native-helpers (or set RECORDLY_HELPER)');
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
    const clickBin = ensureClickLogger();
    if (clickBin) clickProc = spawn(clickBin, [clickPath], { stdio: 'ignore' });
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
    process.stdout.write(s);
    if (!started && buf.includes('Recording started')) {
      started = true;
      if (opts.duration && Number.isFinite(opts.duration) && opts.duration > 0) {
        setTimeout(stop, opts.duration * 1000);
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

function runPostProcess() {
  const useAutozoom = (opts.autoZoom && opts.autoZoom > 1) || !!opts.redact || opts.autoRedact || opts.autoRedactAll;
  if (useAutozoom) {
    return new Promise((resolve, reject) => {
      const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'autozoom.py');
      const zoomVal = (opts.autoZoom && opts.autoZoom > 1) ? opts.autoZoom : (opts.zoom && opts.zoom > 1 ? opts.zoom : 1);
      const args = [script, capturePath, cursorPath, clickPath, String(zoomVal), outputPath];
      if (opts.redact) args.push(opts.redact); else args.push('');
      args.push(opts.autoRedactAll ? 'all' : (opts.autoRedact ? 'sensitive' : ''));
      const p = spawn('python3', args, { stdio: 'inherit' });
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
    const p = spawn(ffmpeg, args, { stdio: 'inherit' });
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

function finish() {
  if (needsPost) {
    runPostProcess()
      .then(() => {
        if (!opts.keepRaw) fs.rmSync(capturePath, { force: true });
        if (!opts.keepRaw) {
          fs.rmSync(cursorPath, { force: true });
          fs.rmSync(clickPath, { force: true });
        }
        if (opts.trimSilence) return trimSilenceFile(outputPath, outputPath);
      })
      .then(() => {
        console.log(`Final: ${outputPath}`);
        if (opts.printMedia) console.log(`MEDIA:${outputPath}`);
        if (opts.open) spawn('open', [outputPath], { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
      })
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
  } else {
    if (opts.trimSilence) {
      trimSilenceFile(outputPath, outputPath).then(() => {
        console.log(`Final: ${outputPath}`);
        if (opts.printMedia) console.log(`MEDIA:${outputPath}`);
        if (opts.open) spawn('open', [outputPath], { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
      }).catch((e) => { console.error(e.message); process.exit(1); });
    } else {
      console.log(`Final: ${outputPath}`);
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
