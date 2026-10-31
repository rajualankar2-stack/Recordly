#!/usr/bin/env node
/**
 * VidCLI MCP server (stdio, no dependencies).
 *
 * Lets an agent record the screen without shelling out by hand:
 *   vidcli_guide    what the tools do and the safe workflow
 *   vidcli_windows  list capturable windows
 *   vidcli_start    start a recording (returns a recording id)
 *   vidcli_status   state of a recording
 *   vidcli_stop     stop it and return the manifest
 *   vidcli_compose  add narration, captions, music and an ending
 *
 * Run:  node cli/mcp.mjs
 * Config (Claude/Hermes style): {"command":"node","args":["<repo>/cli/mcp.mjs"]}
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORD = path.join(HERE, 'record.mjs');
const WINDOW_LIST = path.join(HERE, '..', 'electron', 'native', 'bin',
  process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64', 'openscreen-window-list');

const recordings = new Map();

const GUIDE = {
  summary: 'Record the Mac screen or one window to MP4, with a JSON manifest, optional audio, and blur-by-text redaction.',
  workflow: [
    'vidcli_windows to find a window name (optional).',
    'vidcli_start with output, plus window_name or nothing for the full display.',
    'Do the work you want to show. The manifest start time is the sync anchor for voice-over.',
    'vidcli_stop returns the manifest: started_at/stopped_at (epoch ms), duration_s, redactions, audio flags.',
    'Optional: vidcli_compose adds narration (wav + ts), captions, music and a held last frame with a fade-out.',
  ],
  privacy: 'For public videos pass redact_text with usernames, emails and paths. Check the manifest redactions.boxes count is above 0 and review frames before posting.',
  permissions: 'Needs macOS Screen Recording. system_audio uses the same permission. mic needs Microphone permission.',
  limits: 'One manifest per take. Existing output files are refused unless overwrite is true.',
};

const TOOLS = [
  {
    name: 'vidcli_guide',
    description: 'Explain how to use the VidCLI tools, the workflow, and privacy advice. Call once before recording.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vidcli_windows',
    description: 'List windows that can be captured (app, title, size).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vidcli_start',
    description: 'Start a screen recording in the background. Returns a recording id. Stop it with vidcli_stop.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string', description: 'Absolute path of the .mp4 to write.' },
        window_name: { type: 'string', description: 'Capture the window whose title contains this text.' },
        duration: { type: 'number', description: 'Optional auto-stop in seconds.' },
        fps: { type: 'number' },
        system_audio: { type: 'boolean' },
        mic: { type: 'boolean' },
        auto_zoom: { type: 'number', description: 'Zoom factor that follows the cursor (for example 2).' },
        redact_text: { type: 'string', description: 'Comma-separated words to blur wherever they appear (OCR).' },
        redact: { type: 'string', description: 'Static blur region x,y,w,h.' },
        auto_redact: { type: 'boolean', description: 'Blur emails, phone and card numbers.' },
        overwrite: { type: 'boolean' },
      },
      required: ['output'],
      additionalProperties: false,
    },
  },
  {
    name: 'vidcli_compose',
    description: 'Add narration, captions, music and a gentle ending to a finished take. Lines with ts (epoch ms) are synced to the manifest start time.',
    inputSchema: {
      type: 'object',
      properties: {
        video: { type: 'string', description: 'Absolute path of the recorded .mp4 (its .json manifest sits beside it).' },
        output: { type: 'string', description: 'Absolute path of the final .mp4.' },
        lines: {
          type: 'array',
          description: 'Voice lines. Give ts (epoch ms) or at (seconds into the video), plus wav and caption.',
          items: { type: 'object', properties: { wav: { type: 'string' }, ts: { type: 'number' }, at: { type: 'number' }, caption: { type: 'string' } } },
        },
        music: { type: 'string' },
        offset: { type: 'number' },
        end_hold: { type: 'number' },
        overwrite: { type: 'boolean' },
      },
      required: ['video', 'output', 'lines'],
      additionalProperties: false,
    },
  },
  {
    name: 'vidcli_status',
    description: 'Show the state of a recording (recording, finished, failed).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vidcli_stop',
    description: 'Stop a recording, wait for post-processing, and return the manifest.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, wait_seconds: { type: 'number', description: 'Max wait, default 120.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function text(obj, isError = false) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], isError };
}

function listWindows() {
  if (!fs.existsSync(WINDOW_LIST)) return text('window list helper not found', true);
  const r = spawnSync(WINDOW_LIST, [], { encoding: 'utf8', timeout: 15000 });
  try {
    const rows = JSON.parse(r.stdout).map((w) => ({
      app: w.appName, title: w.windowTitle || w.name, width: w.width, height: w.height,
    }));
    return text(rows);
  } catch {
    return text(`could not read window list: ${(r.stderr || '').slice(0, 200)}`, true);
  }
}

function start(a) {
  if (!a.output || !path.isAbsolute(a.output)) return text('output must be an absolute path', true);
  if (!a.output.endsWith('.mp4')) return text('output must end with .mp4', true);
  if (!fs.existsSync(path.dirname(a.output))) return text(`folder does not exist: ${path.dirname(a.output)}`, true);
  if (fs.existsSync(a.output) && !a.overwrite) return text('output exists; pass overwrite true or choose another path', true);

  const id = `rec-${Date.now().toString(36)}`;
  const stopFile = path.join(os.tmpdir(), `vidcli-mcp-${id}.stop`);
  const args = ['-o', a.output, '--json', '--stop-file', stopFile];
  if (a.overwrite) args.push('--overwrite');
  if (a.window_name) args.push('--window-name', a.window_name);
  if (a.duration) args.push('-d', String(a.duration));
  if (a.fps) args.push('--fps', String(a.fps));
  if (a.system_audio) args.push('--system-audio');
  if (a.mic) args.push('--mic');
  if (a.auto_zoom) args.push('--auto-zoom', String(a.auto_zoom));
  if (a.redact_text) args.push('--redact-text', a.redact_text);
  if (a.redact) args.push('--redact', a.redact);
  if (a.auto_redact) args.push('--auto-redact');

  const child = spawn(process.execPath, [RECORD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { id, output: a.output, stopFile, child, state: 'starting', events: [], stderr: '', exit: null, startedAt: Date.now() };
  recordings.set(id, rec);
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      try {
        const ev = JSON.parse(line);
        rec.events.push(ev.event);
        if (ev.event === 'capture.started') rec.state = 'recording';
        if (ev.event === 'finished') rec.state = 'finished';
      } catch { /* ignore non-JSON */ }
    }
  });
  child.stderr.on('data', (d) => { rec.stderr = (rec.stderr + d.toString()).slice(-600); });
  child.on('exit', (code) => {
    rec.exit = code;
    if (code !== 0 && rec.state !== 'finished') rec.state = 'failed';
    else if (rec.state !== 'failed') rec.state = 'finished';
    fs.rmSync(stopFile, { force: true });
  });
  return text({ id, state: rec.state, output: a.output, note: 'Call vidcli_stop with this id when the demo is done.' });
}

function view(rec) {
  return { id: rec.id, state: rec.state, output: rec.output, exit: rec.exit, events: rec.events,
    seconds_running: Math.round((Date.now() - rec.startedAt) / 100) / 10, stderr_tail: rec.state === 'failed' ? rec.stderr : undefined };
}

function manifestOf(rec) {
  const p = rec.output.replace(/\.mp4$/, '.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

async function stop(a) {
  const rec = recordings.get(a.id);
  if (!rec) return text(`unknown recording id: ${a.id}`, true);
  if (rec.exit === null) fs.writeFileSync(rec.stopFile, 'stop');
  const limit = Date.now() + (a.wait_seconds || 120) * 1000;
  while (rec.exit === null && Date.now() < limit) await new Promise((r) => setTimeout(r, 200));
  if (rec.exit === null) return text({ ...view(rec), error: 'still post-processing; call vidcli_stop again' }, true);
  if (rec.state === 'failed') return text(view(rec), true);
  return text({ ...view(rec), manifest: manifestOf(rec) });
}

function compose(a) {
  for (const k of ['video', 'output']) if (!a[k] || !path.isAbsolute(a[k])) return text(`${k} must be an absolute path`, true);
  if (!fs.existsSync(a.video)) return text(`video not found: ${a.video}`, true);
  if (fs.existsSync(a.output) && !a.overwrite) return text('output exists; pass overwrite true or choose another path', true);
  const lf = path.join(os.tmpdir(), `vidcli-lines-${Date.now().toString(36)}.json`);
  fs.writeFileSync(lf, JSON.stringify({ lines: a.lines || [] }));
  const args = [path.join(HERE, 'compose.py'), '--video', a.video, '--lines', lf, '-o', a.output];
  if (a.music) args.push('--music', a.music);
  if (a.offset !== undefined) args.push('--offset', String(a.offset));
  if (a.end_hold !== undefined) args.push('--end-hold', String(a.end_hold));
  const r = spawnSync('python3', args, { encoding: 'utf8', timeout: 600000 });
  fs.rmSync(lf, { force: true });
  if (r.status !== 0) return text((r.stderr || r.stdout || 'compose failed').slice(-500), true);
  try { return text(JSON.parse(r.stdout)); } catch { return text(r.stdout); }
}

async function callTool(name, args) {
  switch (name) {
    case 'vidcli_compose': return compose(args || {});
    case 'vidcli_guide': return text(GUIDE);
    case 'vidcli_windows': return listWindows();
    case 'vidcli_start': return start(args || {});
    case 'vidcli_status': {
      const rec = recordings.get((args || {}).id);
      return rec ? text(view(rec)) : text('unknown recording id', true);
    }
    case 'vidcli_stop': return stop(args || {});
    default: return text(`unknown tool: ${name}`, true);
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'vidcli', version: '1.0.0' },
    } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments);
      return send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: text(`error: ${e.message}`, true) });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  handle(msg);
});

// Stop any live takes when the client goes away.
function shutdown() {
  for (const rec of recordings.values()) {
    if (rec.exit === null) { try { fs.writeFileSync(rec.stopFile, 'stop'); } catch { /* ignore */ } }
  }
  setTimeout(() => process.exit(0), 3000);
}
rl.on('close', shutdown);
process.on('SIGTERM', shutdown);
