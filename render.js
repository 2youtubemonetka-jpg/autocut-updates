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

function renderVideo({ frames, audioPath, outPath, onProgress, ffmpeg }) {
  const bin = ffmpeg || ffmpegPath();
  const opts = Object.assign({}, (frames[0] && frames[0].opts) || {});
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
    try { fs.writeFileSync(outPath.replace(/\.[^.\\/]+$/, '') + '_log.txt', 'AutoCut render log\n' + new Date().toISOString() + '\nframes=' + fr.length + ' subs=' + hasSubs + ' transitions=' + hasTr + ' fx=' + hasFx + ' film=' + !!film + '\nopts=' + JSON.stringify(Object.assign({}, opts, { blankPng: opts.blankPng ? 'yes' : '' })) + '\nos=' + process.platform + ' tmp=' + os.tmpdir() + '\n', 'utf8'); } catch (_) {}
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
        catch (e) { if (cancelled) throw e; encoderNote += ' (intro/outro/watermark failed, video left without them: ' + String(e.message || e).split('\n')[0].slice(0, 160) + ')'; }
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

module.exports = { renderVideo, buildConcat, ffmpegPath, fitFrames, fxFilter, buildSrt };
