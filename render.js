'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function ffmpegPath(){
  if (process.env.AUTOCUT_FFMPEG) return process.env.AUTOCUT_FFMPEG;
  const res = process.resourcesPath || '';
  for (const n of ['ffmpeg.exe', 'ffmpeg']) {
    const p = path.join(res, n);
    if (res && fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

function clipKey(payload) {
  const h = require('crypto').createHash('sha1');
  h.update(JSON.stringify(payload, (k, v) => (typeof v === 'string' && v.length > 256 ? v.length + ':' + v.slice(0, 64) + ':' + v.slice(-64) : v)));
  return h.digest('hex').slice(0, 20);
}
function purgeResume(root, keep) {   // cached clips of old failed renders are removed after three days
  try {
    for (const d of fs.readdirSync(root)) {
      if (d === keep) continue; const p = path.join(root, d);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 3 * 86400000) fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}
function esc(p){ return p.replace(/\\/g, '/').replace(/'/g, "'\\''"); }

function buildConcat(frames){
  let t = '';
  for (const f of frames) t += "file '" + esc(f.path) + "'\nduration " + Math.max(0.04, f.duration).toFixed(3) + "\n";
  t += "file '" + esc(frames[frames.length - 1].path) + "'\n";
  return t;
}

// real length of the audio: decode it with ffmpeg (header/browser durations of VBR mp3 can be wrong)
function probeAudio(bin, audioPath, setChild) {  // setChild(child) registers the process for cancel
  return new Promise(resolve => {
    let err = '';
    const c = spawn(bin, ['-hide_banner', '-nostats', '-i', audioPath, '-vn', '-f', 'null', '-'], { windowsHide: true });
    setChild(c);
    c.stderr.on('data', d => { err = (err + d.toString()).slice(-6000); });
    c.on('error', () => resolve(0));
    c.on('close', () => {
      const t = [...err.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)].pop();
      if (t) return resolve(+t[1] * 3600 + +t[2] * 60 + parseFloat(t[3]));
      const d = err.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      resolve(d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0);
    });
  });
}

// make the video exactly as long as the audio: stretch/shrink only the LAST frame
function fitFrames(frames, audioLen) {
  const out = frames.map(f => Object.assign({}, f));
  if (!audioLen || !out.length) return out;
  let before = 0;
  for (let i = 0; i < out.length - 1; i++) before += out[i].duration;
  if (audioLen - before >= 0.04) out[out.length - 1].duration = audioLen - before;
  return out;
}

/* ---------- motion effects (zoom / pan on a still image) ---------- */
const FPS = 30;
let VW = 1920, VH = 1080;                 // output size of the current render
let FIT = '', PLAIN = '';
function setGeom(w, h) {
  VW = w; VH = h;
  FIT = 'scale=' + w + ':' + h + ':force_original_aspect_ratio=decrease,pad=' + w + ':' + h + ':(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
  PLAIN = FIT + ',fps=' + FPS + ',format=yuv420p';
}
setGeom(1920, 1080);
const ZW = () => (VW >= 3840 ? 5760 : VW * 2), ZH = () => (VH >= 2160 ? 3240 : VH * 2);
function zpExpr(kind, N, zmax, end) {
  // end=true: the last frame of the move (a single still), otherwise the whole move over N frames
  const p = end ? '1' : 'on/' + Math.max(1, N - 1);
  const zA = (zmax - 1).toFixed(4);
  const cx = 'iw/2-(iw/zoom/2)', cy = 'ih/2-(ih/zoom/2)';
  let z, x, y = cy;
  if (kind === 'in') { z = '1+' + zA + '*' + p; x = cx; }
  else if (kind === 'out') { z = zmax + '-' + zA + '*' + p; x = cx; }
  else if (kind === 'lr') { z = String(zmax); x = '(iw-iw/zoom)*' + p; }          // camera moves left -> right
  else { z = String(zmax); x = '(iw-iw/zoom)*(1-' + p + ')'; }                     // right -> left
  return "zoompan=z='" + z + "':x='" + x + "':y='" + y + "':d=" + (end ? 1 : N) + ':s=' + VW + 'x' + VH + ':fps=' + FPS;
}
function fxFilter(kind, N, zmax) {
  return FIT + ',scale=' + ZW() + ':' + ZH() + ':flags=lanczos,' + zpExpr(kind, N, zmax, false) + ',format=yuv420p';
}
function fxEndFilter(kind, zmax) {        // how a picture with this effect looks on its very last frame
  return FIT + ',scale=' + ZW() + ':' + ZH() + ':flags=lanczos,' + zpExpr(kind, 2, zmax, true) + ',format=yuva420p';
}

// video card encoding: NVIDIA NVENC is used only when a short test encode works on this computer
let hwCache = null;
function hwUsable(bin) {
  if (process.env.AUTOCUT_FORCE_HW) return Promise.resolve(true);      // test hook: pretend the card works
  if (hwCache) return hwCache;
  hwCache = new Promise(resolve => {
    try {
      const c = spawn(bin, ['-hide_banner', '-nostats', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=0.4:r=30', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { windowsHide: true });
      const to = setTimeout(() => { try { c.kill(); } catch (_) {} resolve(false); }, 20000);
      c.on('error', () => { clearTimeout(to); resolve(false); });
      c.on('close', code => { clearTimeout(to); resolve(code === 0); });
      c.stderr.on('data', () => {});
    } catch (_) { resolve(false); }
  });
  return hwCache;
}
function encArgs(hw, quality) {
  if (hw) {
    const cq = { fast: '28', normal: '23', high: '19' }[quality] || '23', pr = { fast: 'p3', normal: 'p4', high: 'p6' }[quality] || 'p4';
    return ['-c:v', 'h264_nvenc', '-preset', pr, '-rc', 'vbr', '-cq', cq, '-b:v', '0', '-bf', '0', '-pix_fmt', 'yuv420p'];
  }
  const Q = { fast: ['veryfast', '24'], normal: ['veryfast', '20'], high: ['medium', '16'] }[quality] || ['veryfast', '20'];
  return ['-c:v', 'libx264', '-preset', Q[0], '-crf', Q[1], '-pix_fmt', 'yuv420p'];
}

function runFf(bin, args, onErr, reg) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { windowsHide: true });
    if (reg) reg(c);
    let tail = '';
    c.stderr.on('data', d => { const t = d.toString(); tail = (tail + t).slice(-2500); if (onErr) onErr(t); });
    c.on('error', reject);
    c.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + '\n' + tail)));
  });
}

function srtTime(t) {
  t = Math.max(0, t); const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), r = ms % 1000;
  const p = (n, w) => String(n).padStart(w, '0'); return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(r, 3);
}
function buildSrt(frames) {
  let t = 0, n = 0, out = '';
  for (const f of frames) {
    const a = t, b = t + f.duration; t = b;
    const txt = String(f.text || '').trim(); if (!txt) continue;
    out += (++n) + '\r\n' + srtTime(a) + ' --> ' + srtTime(Math.max(a + 0.2, b - 0.04)) + '\r\n' + txt + '\r\n\r\n';
  }
  return out;
}

// cut the frame list to the time window [t0, t1] (used for the short trial render)
function cutRange(frames, t0, t1) {
  const out = []; let t = 0;
  for (const f of frames) {
    const a = t, b = t + f.duration; t = b;
    if (b <= t0 || a >= t1) continue;
    const g = Object.assign({}, f); const lo = Math.max(a, t0), hi = Math.min(b, t1); g.duration = hi - lo;
    if (f.subs) { // trim the caption states to the same window
      let s0 = a, ns = [];
      for (const st of f.subs) { const x0 = s0, x1 = s0 + st.d; s0 = x1; const lo2 = Math.max(x0, lo), hi2 = Math.min(x1, hi); if (hi2 > lo2) ns.push({ png: st.png, d: hi2 - lo2 }); }
      g.subs = ns;
    }
    if (lo > a) { g.tr = 0; if (g.flash != null && g.flash !== false) { g.flash -= (lo - a); if (g.flash < -0.05) g.flash = false; else g.flash = Math.max(0, g.flash); } }
    out.push(g);
  }
  return out;
}

// speech loudness: two passes (measure, then a linear gain) so the level is steady and nothing is squashed
const LOUD_I = -16, LOUD_TP = -1.5, LOUD_LRA = 11;
function loudnormExpr(m) {
  let e = 'loudnorm=I=' + LOUD_I + ':TP=' + LOUD_TP + ':LRA=' + LOUD_LRA;
  if (m && isFinite(m.input_i) && isFinite(m.input_tp) && isFinite(m.input_lra) && isFinite(m.input_thresh) && isFinite(m.target_offset))
    e += ':measured_I=' + m.input_i + ':measured_TP=' + m.input_tp + ':measured_LRA=' + m.input_lra + ':measured_thresh=' + m.input_thresh + ':offset=' + m.target_offset + ':linear=true';
  return e;
}
function measureLoud(bin, audioPath, reg) {
  return new Promise(resolve => {
    let text = '';
    runFf(bin, ['-hide_banner', '-nostats', '-i', audioPath, '-af', 'aformat=channel_layouts=stereo,loudnorm=I=' + LOUD_I + ':TP=' + LOUD_TP + ':LRA=' + LOUD_LRA + ':print_format=json', '-vn', '-f', 'null', '-'], t => { text = (text + t).slice(-6000); }, reg)
      .then(() => {
        const m = text.match(/\{[^{}]*"input_i"[^{}]*\}/);
        if (!m) return resolve(null);
        try { const j = JSON.parse(m[0]); const o = {}; for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']) o[k] = parseFloat(j[k]); resolve(o); } catch (_) { resolve(null); }
      }).catch(() => resolve(null));
  });
}

// audio graph: voice (+ background music with ducking) with a fade-out at the end
function audioArgs(opts, voicePath, total, voiceSs) {
  const inp = []; if (voiceSs) inp.push('-ss', String(voiceSs)); inp.push('-i', voicePath);
  const fo = Math.max(0, +opts.fadeOut || 0), parts = [];
  const music = opts.music && opts.music.path ? opts.music : null;
  const vf = opts.normVoice ? 'aformat=channel_layouts=stereo,' + loudnormExpr(opts.normMeasured) + ',aresample=48000,aformat=channel_layouts=stereo,' : '';
  let last;
  if (music) {
    inp.push('-stream_loop', '-1'); if (voiceSs) inp.push('-ss', String(voiceSs)); inp.push('-i', music.path);
    const vol = Math.max(0, Math.min(2, (music.vol == null ? 0.2 : music.vol)));
    parts.push('[1:a]' + vf + 'apad,asplit=2[v1][v2]');
    parts.push('[2:a]volume=' + vol.toFixed(3) + ',afade=t=in:st=0:d=1.5[m]');
    if (music.duck > 0) {
      const ratio = music.duck >= 2 ? 12 : 4;
      parts.push('[m][v1]sidechaincompress=threshold=0.02:ratio=' + ratio + ':attack=25:release=700:makeup=1[md]');
      parts.push('[v2][md]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]');
    } else {
      parts.push('[v1]anullsink;[v2][m]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]');
    }
    last = 'mix';
  } else { parts.push('[1:a]' + vf + 'apad[mix]'); last = 'mix'; }
  // sound effects on scenes: each one is delayed to its moment and laid over the mix
  const sfx = (opts.sfx || []).map(x => ({ path: x.path, at: (+x.at || 0) - (voiceSs || 0), vol: x.vol == null ? 1 : +x.vol }))
    .filter(x => x.path && x.at >= -0.05 && x.at < total - 0.05).slice(0, 200);
  if (sfx.length) {
    const base = music ? 3 : 2, labels = [];
    sfx.forEach((x, k) => {
      inp.push('-i', x.path);
      const ms = Math.max(0, Math.round(x.at * 1000));
      parts.push('[' + (base + k) + ':a]aformat=channel_layouts=mono,volume=' + Math.max(0, Math.min(3, x.vol)).toFixed(3) + ',adelay=' + ms + '|' + ms + '[s' + k + ']');
      labels.push('[s' + k + ']');
    });
    parts.push('[' + last + ']' + labels.join('') + 'amix=inputs=' + (sfx.length + 1) + ':duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95:level=0:latency=1:attack=3:release=60[mixs]');
    last = 'mixs';
  }
  const mf = Math.max(0, +(music && music.fade) || 0), tail = Math.max(fo, mf);
  if (tail > 0) { parts.push('[' + last + ']afade=t=out:st=' + Math.max(0, total - tail).toFixed(3) + ':d=' + tail.toFixed(3) + '[a]'); } else parts.push('[' + last + ']anull[a]');
  return { inp, graph: parts.join(';') };
}

// frames: [{path, duration, fx?, zoom?, tr?, text?, subs?: [{png(base64)|null, d}]}], frames[0].opts = {...}

// channel intro / outro: a picture (shown for a few seconds) or a video file, joined to the finished video
function hasAudioStream(bin, file, reg) {
  return new Promise(resolve => {
    let err = '';
    const c = spawn(bin, ['-hide_banner', '-i', file, '-t', '0.1', '-f', 'null', '-'], { windowsHide: true });
    if (reg) reg(c);
    c.stderr.on('data', d => { err = (err + d.toString()).slice(-8000); });
    c.on('error', () => resolve(false));
    c.on('close', () => resolve(/Stream #\d+:\d+.*Audio:/.test(err)));
  });
}
async function makeBookend(bin, seg, out, opts, reg) {
  const enc = encArgs(false, opts.quality), isVid = seg.kind === 'video';
  const dur = Math.max(0.5, Math.min(60, +seg.dur || 3));
  const args = ['-y', '-hide_banner'];
  let aud = false;
  if (isVid) { aud = await hasAudioStream(bin, seg.path, reg); args.push('-t', String(dur), '-i', seg.path); }
  else args.push('-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', seg.path);
  if (!aud) args.push('-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-vf', PLAIN, '-map', '0:v:0', '-map', aud ? '0:a:0' : '1:a:0');
  if (aud) args.push('-af', 'aresample=48000,aformat=channel_layouts=stereo');
  args.push(...enc, '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', String(dur), out);
  await runFf(bin, args, null, reg);
}
async function addBookends(bin, outPath, opts, tmpRoot, reg) {
  const parts = [];
  if (opts.intro && opts.intro.path) { const o = path.join(tmpRoot, 'intro.mp4'); await makeBookend(bin, opts.intro, o, opts, reg); parts.push(o); }
  const mainIdx = parts.length; parts.push(outPath);
  if (opts.outro && opts.outro.path) { const o = path.join(tmpRoot, 'outro.mp4'); await makeBookend(bin, opts.outro, o, opts, reg); parts.push(o); }
  // channel watermark: a picture (or text drawn by the app as a picture) over the main part only
  let wmFile = '';
  const wm = opts.wm && (opts.wm.path || opts.wm.png) ? opts.wm : null;
  if (wm) { wmFile = wm.path || path.join(tmpRoot, 'wm.png'); if (!wm.path) fs.writeFileSync(wmFile, Buffer.from(wm.png, 'base64')); }
  const cts = (opts.ct || []).filter(x => x && x.png && isFinite(x.t)).slice(0, 40);
  cts.forEach((x, k) => { x.file = path.join(tmpRoot, 'ct' + k + '.png'); fs.writeFileSync(x.file, Buffer.from(x.png, 'base64')); });
  if (parts.length < 2 && !wm && !cts.length) return;
  const tmpOut = path.join(tmpRoot, 'joined.mp4'), args = ['-y', '-hide_banner'];
  parts.forEach(f => args.push('-i', f));
  if (wm) args.push('-loop', '1', '-framerate', String(FPS), '-i', wmFile);
  cts.forEach(x => args.push('-loop', '1', '-framerate', String(FPS), '-t', String(Math.max(1, +x.dur || 3)), '-i', x.file));
  let g = '';
  parts.forEach((f, i) => {
    g += '[' + i + ':v]setsar=1,fps=' + FPS + ',format=yuv420p[v' + i + ((wm || cts.length) && i === mainIdx ? 'p' : '') + '];[' + i + ':a]aresample=48000,aformat=channel_layouts=stereo[a' + i + '];';
  });
  if (wm) {
    const op = Math.max(0.05, Math.min(1, +wm.opacity || 0.7)), wpx = Math.max(24, Math.round(VW * Math.max(0.03, Math.min(0.5, (+wm.size || 12) / 100)) / 2) * 2), M = Math.round(VW * 0.02);
    const pos = { tl: 'x=' + M + ':y=' + M, tr: 'x=W-w-' + M + ':y=' + M, bl: 'x=' + M + ':y=H-h-' + M, br: 'x=W-w-' + M + ':y=H-h-' + M }[wm.pos] || 'x=W-w-' + M + ':y=H-h-' + M;
    g += '[' + parts.length + ':v]format=rgba,colorchannelmixer=aa=' + op.toFixed(2) + ',scale=' + wpx + ':-2[wm];[v' + mainIdx + 'p][wm]overlay=' + pos + ':shortest=1,format=yuv420p[v' + mainIdx + (cts.length ? 'w' : '') + '];';
  }
  if (cts.length) {
    // part titles: each one fades in at its chapter start and out again, over the main part only
    let cur = 'v' + mainIdx + 'p';
    if (wm) { cur = 'v' + mainIdx + 'w'; }
    const base = parts.length + (wm ? 1 : 0);
    cts.forEach((x, k) => {
      const D = Math.max(1, +x.dur || 3), nxt = k === cts.length - 1 && true ? null : null;
      g += '[' + (base + k) + ':v]format=rgba,scale=' + VW + ':' + VH + ',fade=t=in:st=0:d=0.35:alpha=1,fade=t=out:st=' + Math.max(0.4, D - 0.5).toFixed(2) + ':d=0.5:alpha=1,setpts=PTS+' + Math.max(0, +x.t).toFixed(3) + '/TB[ct' + k + '];';
      g += '[' + cur + '][ct' + k + ']overlay=eof_action=pass:format=auto,format=yuv420p[' + (k === cts.length - 1 ? 'v' + mainIdx : 'c' + k) + '];';
      cur = 'c' + k;
    });
  }
  g += parts.map((f, i) => '[v' + i + '][a' + i + ']').join('') + 'concat=n=' + parts.length + ':v=1:a=1[v][a]';
  args.push('-filter_complex', g, '-map', '[v]', '-map', '[a]', ...encArgs(false, opts.quality), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmpOut);
  await runFf(bin, args, null, reg);
  fs.copyFileSync(tmpOut, outPath);
}


// scratch files go next to the finished video (same drive); the system temp drive is only a fallback
function workBase(outPath){
  try { const d = path.join(path.dirname(outPath), '.autocut_work'); fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { return os.tmpdir(); }
}
function freeBytes(dir){
  try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch (_) { return null; }
}


/* ---------- license (Pro): a key signed by the seller, bound to this computer, with an end date ---------- */
const LIC_PUB = 'oxYBZS+yRjcM8Rupw3WQg++YZJlCV+2gEC8yK6SzMZk=';
const licCrypto = require('crypto');
function licDir() { try { return require('electron').app.getPath('userData'); } catch (_) { return path.join(os.homedir(), '.autocut'); } }
const licFile = () => path.join(licDir(), 'license.key');
let licMachine = null;
function machineCode() {
  if (licMachine) return licMachine;
  let raw = '';
  try {
    if (process.platform === 'win32') {
      const out = require('child_process').execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/); if (m) raw = m[1].toLowerCase();
    }
  } catch (_) {}
  if (!raw) raw = [os.hostname(), (os.cpus()[0] || {}).model || '', os.totalmem(), os.platform()].join('|');
  const h = licCrypto.createHash('sha256').update('autocut-lic|' + raw).digest('hex').toUpperCase();
  return (licMachine = h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12));
}
const licB64 = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function checkKey(key) {
  key = String(key || '').replace(/\s+/g, '');
  if (!key) return { ok: false, reason: 'none' };
  const parts = key.split('.'); if (parts.length !== 2) return { ok: false, reason: 'format' };
  const payload = licB64(parts[0]), sig = licB64(parts[1]);
  let good = false;
  try {
    const pk = licCrypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(LIC_PUB, 'base64')]), format: 'der', type: 'spki' });
    good = sig.length === 64 && licCrypto.verify(null, payload, pk, sig);
  } catch (_) {}
  if (!good) return { ok: false, reason: 'signature' };
  const f = payload.toString('utf8').split('|');          // AC1|MACHINE|YYYY-MM-DD or LIFE|PLAN|ID
  if (f[0] !== 'AC1') return { ok: false, reason: 'format' };
  if (f[1] !== machineCode()) return { ok: false, reason: 'machine' };
  if (f[2] !== 'LIFE') { const end = new Date(f[2] + 'T23:59:59'); if (!(end >= new Date())) return { ok: false, reason: 'expired', exp: f[2] }; }
  return { ok: true, exp: f[2], plan: f[3] || 'PRO', id: f[4] || '' };
}
function licenseStatus() {
  let key = ''; try { key = fs.readFileSync(licFile(), 'utf8').trim(); } catch (_) {}
  const st = checkKey(key); st.machine = machineCode(); st.hasKey = !!key; return st;
}
function licenseQuery(o) {
  if (o && typeof o.setKey === 'string') {
    const k = o.setKey.replace(/\s+/g, '');
    if (!k) { try { fs.unlinkSync(licFile()); } catch (_) {} }
    else {
      const st = checkKey(k);
      if (!st.ok) { st.machine = machineCode(); st.rejected = true; return st; }
      fs.mkdirSync(licDir(), { recursive: true }); fs.writeFileSync(licFile(), k);
    }
  }
  return licenseStatus();
}
const FREE_WM = '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p9PdrFmzZkabNm2yRo0alff555+X3rhxQzalqlu3bjqRxdCUWrW7CIyFAJSW91WK1AB3Q6PRoHv37h61T2rxlfK9EoFE8+bNNa1bt2bdPKkXYF8/GkAtlgsnTJhgFJErlYlbt245d+zYUWm02A8//GAuLS2VdOUdGhrKDR8+nNVHaAI+NYNiESFMkILh57z66quhnTt31laX78txHP773/9GhIeHe2R8WrdurTUYDLIJ1lu2bGGNes0CcINmMtk4QlloqAvEcfToUdvOnTutniyiVSoVZs2aFfzMM88UVnVtly5dtFI8/BYsWBCwhbYcDgcOHTpkS0lJsaakpFgOHTpkFytCWa1Wl9VqRWFhoePKlSuOQ4cO3XbUtXHjxurRo0cbp0+fHiRXlGOfPn10iYmJmjNnzrCIvW1YnfTp06cHiTwy7hY2mw2bN282//TTT5YjR47YLl686CgsLHSq1WouPDyca9KkiaZjx47ahx56SJ+cnKyXenElIUz3dlRUlOqtt94KlasRt27dci5cuLBk6dKlpbm5uRVunGRkZDgzMjKcx48ft69du9as1WoxZcqUoFdeeSWkTp06ko/5Sy+9FLJixQoT4/3VUFhw5yhwjNMBRFV10bZt2yyvvvpqiFQf6qn4Kmf13LL3F+HY34bRaOQ6depE+V4JohJGjRplPH78OEvRv/gA++rMUZ3uFqatjDVr1piqihYr2+gcNWqUpALoxIkTjV999RXLqTk1gEQARwJAmCD8mAYNGqife+45r+TS3rVrl/V///ufZf/+/da0tDRHbm6u02KxuEJCQrg6deqoW7Roobnvvvv0w4YNM8TFxckaNBYXF6d69dVXQ5999tlCd98jISFB1vVWamoq66b0aZrJZOMI5UGRr24ghZD52GOPBbEUE5Ai6vW3336zHj9+3B5IY2CxWFwbNmwwT548OT8uLi6jc+fO2c8991zh5s2bLXJE/124cMHx9ttvFyckJGS9/PLLRXIdhZ0yZQprSoraLBdptVoxEbVu4XA48PHHH5fWq1cvY/jw4Xmffvpp6YEDB2w5OTlOm80Gs9nsysjIcO7evdv64YcflvTt2ze3WbNmWevWrfPr4m///ve/Q+XKobt27Vpz8+bNs95+++3iuwmvFWGz2bB06dLS5s2bZ23atEny/g0ODubefvttMYJzkkKHjyn1QGpq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';
function renderVideo({ frames, audioPath, outPath, onProgress, ffmpeg }) {
  const bin = ffmpeg || ffmpegPath();
  const opts = Object.assign({}, (frames[0] && frames[0].opts) || {});
  if (opts.licenseQuery) { const st = licenseQuery(opts); if (onProgress) onProgress({ license: st }); return { promise: Promise.resolve(st), cancel: () => {} }; }
  const LIC = licenseStatus(), FREE = !LIC.ok;
  if (FREE) opts.wm = { png: FREE_WM, pos: 'br', size: 26, opacity: 0.9 };   // free version: AutoCut mark on full videos (not on the 20 s preview)
  const vertical = !!opts.vertical;
  const GEO = vertical ? [1920, 1080] : { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] }[+opts.height] || [1920, 1080];
  setGeom(GEO[0], GEO[1]);
  const Q = { fast: ['veryfast', '24'], normal: ['veryfast', '20'], high: ['medium', '16'] }[opts.quality] || ['veryfast', '20'];
  const kids = new Set();
  let cancelled = false, tail = '', encoderUsed = 'cpu (still images, one pass)', encoderNote = '';
  const tStart = Date.now();
  const reg = c => { kids.add(c); c.on('close', () => kids.delete(c)); };
  const promise = (async () => {
    if (onProgress) onProgress(0);
    let fr, voiceSs = 0;
    if (opts.range) {
      voiceSs = Math.max(0, opts.range.t0);
      fr = cutRange(frames, opts.range.t0, opts.range.t1);
      fr.forEach(f => { f.opts = undefined; });
    } else {
      const audioLen = await probeAudio(bin, audioPath, reg);
      if (cancelled) throw new Error('cancelled');
      fr = fitFrames(frames, audioLen);
    }
    const total = fr.reduce((s, f) => s + f.duration, 0);
    if (opts.srt && !opts.range) { try { fs.writeFileSync(outPath.replace(/\.[^.\\/]+$/, '') + '.srt', '﻿' + buildSrt(fr), 'utf8'); } catch (_) {} }
    const hasSubs = !!opts.burn && fr.some(f => f.subs && f.subs.some(s => s.png));
    const hasTr = fr.some((f, i) => i > 0 && f.tr > 0);
    const hasFx = fr.some(f => f.fx);
    const film = hasFilm(opts.film, fr) ? opts.film : null;
    const fadeIn = Math.max(0, +opts.fadeIn || 0), fadeOutV = Math.max(0, +opts.fadeOut || 0);
    try { fs.writeFileSync(outPath.replace(/\.[^.\\/]+$/, '') + '_log.txt', 'AutoCut render log\n' + new Date().toISOString() + '\nframes=' + fr.length + ' subs=' + hasSubs + ' transitions=' + hasTr + ' fx=' + hasFx + ' film=' + !!film + '\nopts=' + JSON.stringify(Object.assign({}, opts, { blankPng: opts.blankPng ? 'yes' : '', wm: opts.wm ? Object.assign({}, opts.wm, { png: opts.wm.png ? 'yes' : '' }) : undefined, ct: opts.ct ? opts.ct.length : undefined })) + '\nos=' + process.platform + ' tmp=' + os.tmpdir() + '\n', 'utf8'); } catch (_) {}
    if (opts.normVoice) { opts.normMeasured = await measureLoud(bin, audioPath, reg); if (cancelled) throw new Error('cancelled'); }
    const WB = workBase(outPath);
    { const need = total * ({ 720: 2, 1080: 4, 1440: 8, 2160: 14 }[+opts.height] || 4) * 1e6 * (opts.quality === 'high' ? 1.4 : 1) * 2 + 3e8, free = freeBytes(WB);
      if (free !== null && free < need) throw new Error('Not enough free disk space: about ' + (need / 1e9).toFixed(1) + ' GB needed, ' + (free / 1e9).toFixed(1) + ' GB free on the drive of ' + WB + '. Free some space or choose a lower resolution or quality.'); }
    const tmpRoot = fs.mkdtempSync(path.join(WB, 'autocut_'));
    let cacheDir = null, reused = 0;
    // if the loudness filter chain fails on some ffmpeg build, the same step is repeated without it
    const audioRetry = async build => {
      try { if (process.env.AUTOCUT_FAIL_NORM && opts.normVoice) throw new Error('Cannot select channel layout (test hook)'); await build(); }
      catch (e) {
        if (opts.normVoice && !cancelled && /channel layout|Invalid argument|Error reinitializing|Failed to inject/i.test(String(e.message || e))) {
          opts.normVoice = false; encoderNote += ' (loudness normalisation failed on this ffmpeg, rendered without it: ' + String(e.message || e).split('\n')[0].slice(0, 100) + ')';
          await build();
        } else throw e;
      }
    };
    try {
      if (!hasFx && !hasTr && !hasSubs && !vertical && !film) {
        // fast path: one pass, still images through the concat demuxer
        const list = path.join(tmpRoot, 'list.txt');
        fs.writeFileSync(list, buildConcat(fr), 'utf8');
        let vf = FIT + ',fps=' + FPS + ',format=yuv420p,tpad=stop_mode=clone:stop_duration=5';
        if (fadeIn > 0) vf += ',fade=t=in:st=0:d=' + fadeIn.toFixed(2);
        if (fadeOutV > 0) vf += ',fade=t=out:st=' + Math.max(0, total - fadeOutV).toFixed(3) + ':d=' + fadeOutV.toFixed(2);
        await audioRetry(async () => {
        const aa = audioArgs(opts, audioPath, total, voiceSs);
        const args = ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, ...aa.inp, '-filter_complex', aa.graph, '-map', '0:v', '-vf', vf, '-map', '[a]',
          '-c:v', 'libx264', '-preset', Q[0], '-crf', Q[1], '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', outPath];
        await runFf(bin, args, t => {
          tail = (tail + t).slice(-2500);
          const m = [...t.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)].pop();
          if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) / total));
        }, reg);
        });
      } else {
        // every picture becomes a clip with an exact frame count; the clips are joined without re-encoding
        let acc = 0; const counts = [];
        for (const f of fr) { const a0 = Math.round(acc * FPS); acc += f.duration; counts.push(Math.max(1, Math.round(acc * FPS) - a0)); }
        const nFrames = counts.reduce((a, b) => a + b, 0);
        // finished clips are kept in a folder named after everything that shapes them: after a failure the next run reuses them
        const stat = f => { try { const t = fs.statSync(f); return t.size + ':' + Math.round(t.mtimeMs); } catch (_) { return ''; } };
        const resumeRoot = path.join(WB, 'autocut_resume');
        const key = clipKey({ fr: fr.map(f => Object.assign({}, f, { opts: undefined })), st: fr.map(f => stat(f.path)), film, vertical, q: opts.quality, fadeIn, fadeOutV, W: VW, H: VH, counts });
        cacheDir = path.join(resumeRoot, key); fs.mkdirSync(cacheDir, { recursive: true }); try { fs.utimesSync(cacheDir, new Date(), new Date()); } catch (_) {}
        purgeResume(resumeRoot, key);
        const clips = fr.map((_, i) => path.join(cacheDir, 'c' + String(i).padStart(4, '0') + '.mp4'));
        // caption pictures -> files
        let blank = null;
        if (hasSubs) {
          blank = path.join(tmpRoot, 'blank.png'); fs.writeFileSync(blank, Buffer.from(opts.blankPng, 'base64'));
        }
        const subLists = fr.map((f, i) => {
          if (!hasSubs || !f.subs || !f.subs.some(s => s.png)) return null;
          const N = counts[i], want = N / FPS; let sum = f.subs.reduce((a, s) => a + s.d, 0);
          const lines = []; let used = 0;
          f.subs.forEach((s, k) => {
            let file = blank; if (s.png){ file = path.join(tmpRoot, 's' + i + '_' + k + '.png'); fs.writeFileSync(file, Buffer.from(s.png, 'base64')); }
            let d = s.d * (want / Math.max(0.001, sum)); d = Math.max(1 / FPS, d); used += d; lines.push("file '" + esc(file) + "'\nduration " + d.toFixed(4));
          });
          lines.push("file '" + esc(blank) + "'");
          const lf = path.join(tmpRoot, 'sub' + i + '.txt'); fs.writeFileSync(lf, lines.join('\n') + '\n', 'utf8'); return lf;
        });
        const runClips = async (hw) => {
        let done = 0, next = 0;
        const workers = hw ? 3 : Math.max(1, Math.min(4, (os.cpus() || []).length - 1 || 1));
        const worker = async () => {
          while (next < fr.length && !cancelled) {
            const i = next++, f = fr[i], N = counts[i];
            const marker = clips[i].replace(/\.mp4$/, '.ok'), tag = hw ? 'hw' : 'cpu';
            try { if (fs.existsSync(clips[i]) && fs.readFileSync(marker, 'utf8') === tag) { reused++; done++; if (onProgress) onProgress(0.92 * done / fr.length); continue; } } catch (_) {}
            try { fs.unlinkSync(marker); } catch (_) {}
            if (process.env.AUTOCUT_FAIL_AT && i === +process.env.AUTOCUT_FAIL_AT) throw new Error('test hook: clip ' + i);
            const args = ['-y', '-hide_banner', '-nostats'];
            const g = [];                                 // filter_complex pieces
            let idx = 0;
            // main picture
            const useFx = f.fx && N >= 2;
            if (useFx) { args.push('-i', f.path); g.push('[' + idx + ':v]' + fxFilter(f.fx, N, f.zoom || 1.2) + '[a0]'); }
            else { args.push('-loop', '1', '-framerate', String(FPS), '-i', f.path); g.push('[' + idx + ':v]' + PLAIN + '[a0]'); }
            idx++;
            let cur = 'a0';
            // dissolve from the previous picture
            const F = Math.min(Math.round((f.tr || 0) * FPS), Math.floor(N / 2));
            if (i > 0 && F >= 2) {
              const p = fr[i - 1];
              args.push('-loop', '1', '-framerate', String(FPS), '-i', p.path);
              const chain = p.fx ? fxEndFilter(p.fx, p.zoom || 1.2) : (FIT + ',format=yuva420p');
              const style = f.trs || 'fade', D = (F / FPS).toFixed(3);
              if (style === 'black' || style === 'white') {
                // the old picture fades away over a flat colour, then the new one fades in from it
                const H2 = Math.max(1, Math.floor(F / 2)), d2 = (H2 / FPS).toFixed(3);
                g.push('[' + idx + ':v]' + chain + ',trim=end_frame=' + H2 + ',setpts=PTS-STARTPTS,fade=t=out:st=0:d=' + d2 + ':alpha=1[b0]');
                g.push('[' + cur + ']format=yuv420p,fade=t=in:st=' + d2 + ':d=' + d2 + ':color=' + style + '[a0f]');
                g.push('[a0f][b0]overlay=0:0:eof_action=pass:format=auto[a1]');
              } else if (style === 'slide') {
                g.push('[' + idx + ':v]' + chain + ',trim=end_frame=' + F + ',setpts=PTS-STARTPTS[b0]');
                g.push('[' + cur + '][b0]overlay=x=\'-w*min(t/' + D + ',1)\':y=0:eof_action=pass:format=auto[a1]');
              } else if (style === 'glitch') {
                // a few frames of the old picture, torn sideways and noisy
                g.push('[' + idx + ':v]' + chain + ',trim=end_frame=' + F + ',setpts=PTS-STARTPTS,noise=alls=45:allf=t[b0]');
                g.push('[' + cur + '][b0]overlay=x=\'if(lt(mod(n,4),2),26,-20)\':y=\'if(lt(mod(n,3),1),0,8)\':eof_action=pass:format=auto:enable=\'lt(mod(n,5),3)\'[a1]');
              } else {
                g.push('[' + idx + ':v]' + chain + ',trim=end_frame=' + F + ',setpts=PTS-STARTPTS,fade=t=out:st=0:d=' + D + ':alpha=1[b0]');
                g.push('[' + cur + '][b0]overlay=0:0:eof_action=pass:format=auto[a1]');
              }
              cur = 'a1'; idx++;
            }
            // vertical (Shorts): the 16:9 picture sits in the middle of a blurred copy of itself
            if (vertical) {
              g.push('[' + cur + ']format=yuv420p,split=2[vv1][vv2]');
              g.push('[vv1]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:3[vbg]');
              g.push('[vv2]scale=1080:-2[vfg]');
              g.push('[vbg][vfg]overlay=0:(H-h)/2[vw]'); cur = 'vw';
            }
            // film layer
            if (film) {
              const fc = filmChain(film, film.flash && f.flash != null && f.flash !== false ? f.flash : false, vertical ? 1080 : VW, vertical ? 1920 : VH);
              if (fc.length) { g.push('[' + cur + ']format=yuv420p,' + fc.join(',') + '[fl]'); cur = 'fl'; }
            }
            // captions
            if (subLists[i]) {
              args.push('-f', 'concat', '-safe', '0', '-i', subLists[i]);
              g.push('[' + idx + ':v]format=rgba' + (VW !== 1920 ? ',scale=' + VW + ':-2:flags=lanczos' : '') + '[s0]');
              g.push('[' + cur + '][s0]overlay=0:' + (vertical ? '(H-h)/2' : 'H-h') + ':eof_action=pass:format=auto[a2]'); cur = 'a2'; idx++;
            }
            // fade from / to black on the first / last clip
            let tailChain = 'format=yuv420p';
            if (i === 0 && fadeIn > 0) tailChain += ',fade=t=in:st=0:d=' + Math.min(fadeIn, N / FPS).toFixed(2);
            if (i === fr.length - 1 && fadeOutV > 0) { const d = Math.min(fadeOutV, N / FPS); tailChain += ',fade=t=out:st=' + (N / FPS - d).toFixed(3) + ':d=' + d.toFixed(2); }
            g.push('[' + cur + ']' + tailChain + '[vout]');
            args.push('-filter_complex', g.join(';'), '-map', '[vout]', ...encArgs(hw, opts.quality), '-r', String(FPS), '-an', '-frames:v', String(N), clips[i]);
            await runFf(bin, args, null, reg);
            try { fs.writeFileSync(marker, tag); } catch (_) {}
            done++; if (onProgress) onProgress(0.92 * done / fr.length);
          }
        };
        await Promise.all(Array.from({ length: workers }, worker));
        };
        let hwUse = opts.hw !== 'off' && await hwUsable(bin);
        if (cancelled) throw new Error('cancelled');
        if (hwUse) {
          try { await runClips(true); encoderUsed = 'nvenc'; }
          catch (e) { if (cancelled) throw e; hwUse = false; encoderNote = ' (video card failed, redone on the processor: ' + String(e.message || e).split('\n')[0].slice(0, 120) + ')'; }
        }
        if (!hwUse) { await runClips(false); encoderUsed = 'cpu'; }
        if (cancelled) throw new Error('cancelled');
        const list = path.join(tmpRoot, 'clips.txt');
        fs.writeFileSync(list, clips.map(c => "file '" + esc(c) + "'").join('\n') + '\n', 'utf8');
        const dur = nFrames / FPS;
        await audioRetry(async () => {
        const aa2 = audioArgs(opts, audioPath, dur, voiceSs);
        await runFf(bin, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, ...aa2.inp, '-filter_complex', aa2.graph, '-map', '0:v', '-map', '[a]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', dur.toFixed(3), '-movflags', '+faststart', outPath], t => {
          const m = [...t.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)].pop();
          if (m && onProgress) onProgress(Math.min(1, 0.92 + 0.08 * (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) / dur));
        }, reg);
        });
        if (reused) encoderNote += ' (reused ' + reused + ' finished clips from the previous attempt)';
        try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (_) {}
      }
      if (cancelled) throw new Error('cancelled');
      if (!opts.range && ((!vertical && ((opts.intro && opts.intro.path) || (opts.outro && opts.outro.path))) || (opts.wm && (opts.wm.path || opts.wm.png)) || (!vertical && opts.ct && opts.ct.length))) {
        const bo = vertical ? Object.assign({}, opts, { intro: null, outro: null, ct: null }) : opts;
        try { await addBookends(bin, outPath, bo, tmpRoot, reg); encoderNote += ' +' + [bo.intro || bo.outro ? 'intro/outro' : '', opts.wm ? 'watermark' : '', (!vertical && opts.ct && opts.ct.length) ? 'titles' : ''].filter(Boolean).join('+'); }
        catch (e) { if (cancelled) throw e; if (FREE) throw new Error('could not add the AutoCut mark of the free version: ' + String(e.message || e).split('\n')[0].slice(0, 160)); encoderNote += ' (intro/outro/watermark failed, video left without them: ' + String(e.message || e).split('\n')[0].slice(0, 160) + ')'; }
      }
      if (cancelled) throw new Error('cancelled');
      if (onProgress) onProgress(1);
      try { fs.appendFileSync(outPath.replace(/\.[^.\\/]+$/, '') + '_log.txt', 'encoder=' + encoderUsed + encoderNote + ' seconds=' + ((Date.now() - tStart) / 1000).toFixed(1) + '\n', 'utf8'); } catch (_) {}
      return outPath;
    } catch (e) {
      if (cancelled) throw new Error('cancelled');
      throw e;
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
    }
  })();
  return { promise, cancel: () => { cancelled = true; kids.forEach(c => { try { c.kill(); } catch (_) {} }); } };
}

// film layer: tone, shake, grain, vignette and a flash on chosen pictures (applied to every clip)
function filmChain(film, flash, W, H) {
  const out = [];
  if (!film) return out;
  if (film.shake > 0) {
    const SK = { 1: [1.008, 0.18], 2: [1.014, 0.3], 3: [1.025, 0.5], 4: [1.035, 0.8], 5: [1.07, 0.95] }[Math.min(5, Math.max(1, Math.round(film.shake)))];
    const z = SK[0], a = SK[1];
    out.push('crop=w=iw/' + z + ':h=ih/' + z + ":x='(iw-ow)/2*(1+" + a + "*(sin(n*0.83)+0.5*sin(n*2.1+1))/1.5)':y='(ih-oh)/2*(1+" + a + "*(sin(n*1.07+2)+0.5*sin(n*2.7))/1.5)',scale=" + W + ':' + H + ':flags=bilinear,setsar=1');
  }
  if (film.tone === 'dark') out.push('eq=saturation=0.7:contrast=1.1:brightness=-0.03');
  else if (film.tone === 'warm') out.push('colorbalance=rs=0.07:gs=0.01:bs=-0.07:rm=0.05:bm=-0.05');
  else if (film.tone === 'cold') out.push('colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.06');
  if (film.grain > 0) out.push('noise=alls=' + [0, 7, 13, 22][Math.min(3, film.grain)] + ':allf=t');
  if (film.vig > 0) out.push('vignette=angle=' + (film.vig >= 2 ? 'PI/3.2' : 'PI/4.6'));
  if (flash !== false && flash != null) {
    const a = Math.max(0, +flash || 0);
    out.push("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.55:t=fill:enable='between(t," + a.toFixed(3) + ',' + (a + 0.07).toFixed(3) + ")'");
    out.push("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.22:t=fill:enable='between(t," + (a + 0.07).toFixed(3) + ',' + (a + 0.17).toFixed(3) + ")'");
  }
  return out;
}
function hasFilm(film, fr) { return !!film && (film.shake > 0 || film.grain > 0 || film.vig > 0 || (film.tone && film.tone !== 'none') || (film.flash && fr.some(f => f.flash != null && f.flash !== false))); }

module.exports = { renderVideo, buildConcat, ffmpegPath, fitFrames, fxFilter, buildSrt, checkKey, machineCode, licenseStatus };
