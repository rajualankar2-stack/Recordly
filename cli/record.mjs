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
  fps: 60,
  systemAudio: false,
  mic: false,
  help: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') opts.help = true;
  else if (a === '-o' || a === '--output') opts.output = args[++i];
  else if (a === '-d' || a === '--duration') opts.duration = Number(args[++i]);
  else if (a === '--display') opts.display = args[++i];
  else if (a === '--window') opts.window = args[++i];
  else if (a === '--fps') opts.fps = Number(args[++i]);
  else if (a === '--system-audio') opts.systemAudio = true;
  else if (a === '--mic') opts.mic = true;
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
  -h, --help              Show help
`);
  process.exit(0);
}

const timestamp = Date.now();
const outputPath = opts.output
  ? path.resolve(opts.output)
  : path.resolve(process.cwd(), `recordly-${timestamp}.mp4`);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

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

function ffmpegPath() {
  const candidates = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return 'ffmpeg';
}

function buildMacConfig() {
  const cfg = { fps: opts.fps, outputPath, capturesSystemAudio: opts.systemAudio, capturesMicrophone: opts.mic };
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
  console.log(`Recording to ${outputPath}`);
  console.log('Press Ctrl+C to stop' + (opts.duration ? ` (or wait ${opts.duration}s)` : '') + '.');

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
    // ensure output path printed
    const m = buf.match(/Recording stopped\. Output path: (.+)/);
    const finalPath = m ? m[1].trim() : outputPath;
    if (code === 0) {
      console.log(`\nSaved: ${finalPath}`);
    } else {
      console.error(`\nRecording failed (exit ${code})`);
      process.exit(code ?? 1);
    }
    process.exit(0);
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
  const args = [...inputArgs, '-r', String(opts.fps), outputPath];
  console.log(`Recording to ${outputPath} via ffmpeg (Ctrl+C to stop)`);
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
    console.log(`\nSaved: ${outputPath}`);
    process.exit(code ?? 0);
  });
}

if (process.platform === 'darwin') {
  recordMac();
} else {
  recordFfmpeg();
}
