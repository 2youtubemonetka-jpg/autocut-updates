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
const FIT = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
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
  return "zoompan=z='" + z + "':x='" + x + "':y='" + y + "':d=" + (end ? 1 : N) + ':s=1920x1080:fps=' + FPS;
}
function fxFilter(kind, N, zmax) {
  return FIT + ',scale=3840:2160:flags=lanczos,' + zpExpr(kind, N, zmax, false) + ',format=yuv420p';
}
function fxEndFilter(kind, zmax) {        // how a picture with this effect looks on its very last frame
  return FIT + ',scale=3840:2160:flags=lanczos,' + zpExpr(kind, 2, zmax, true) + ',format=yuva420p';
}
const PLAIN = FIT + ',fps=' + FPS + ',format=yuv420p';

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
    if (lo > a) g.tr = 0;
    out.push(g);
  }
  return out;
}

// audio graph: voice (+ background music with ducking) with a fade-out at the end
function audioArgs(opts, voicePath, total, voiceSs) {
  const inp = []; if (voiceSs) inp.push('-ss', String(voiceSs)); inp.push('-i', voicePath);
  const fo = Math.max(0, +opts.fadeOut || 0), parts = [];
  const music = opts.music && opts.music.path ? opts.music : null;
  let last;
  if (music) {
    inp.push('-stream_loop', '-1'); if (voiceSs) inp.push('-ss', String(voiceSs)); inp.push('-i', music.path);
    const vol = Math.max(0, Math.min(2, (music.vol == null ? 0.2 : music.vol)));
    parts.push('[1:a]apad,asplit=2[v1][v2]');
    parts.push('[2:a]volume=' + vol.toFixed(3) + ',afade=t=in:st=0:d=1.5[m]');
    if (music.duck > 0) {
      const ratio = music.duck >= 2 ? 12 : 4;
      parts.push('[m][v1]sidechaincompress=threshold=0.02:ratio=' + ratio + ':attack=25:release=700:makeup=1[md]');
      parts.push('[v2][md]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]');
    } else {
      parts.push('[v1]anullsink;[v2][m]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]');
    }
    last = 'mix';
  } else { parts.push('[1:a]apad[mix]'); last = 'mix'; }
  const mf = Math.max(0, +(music && music.fade) || 0), tail = Math.max(fo, mf);
  if (tail > 0) { parts.push('[' + last + ']afade=t=out:st=' + Math.max(0, total - tail).toFixed(3) + ':d=' + tail.toFixed(3) + '[a]'); } else parts.push('[' + last + ']anull[a]');
  return { inp, graph: parts.join(';') };
}

// frames: [{path, duration, fx?, zoom?, tr?, text?, subs?: [{png(base64)|null, d}]}], frames[0].opts = {...}
function renderVideo({ frames, audioPath, outPath, onProgress, ffmpeg }) {
  const bin = ffmpeg || ffmpegPath();
  const opts = Object.assign({}, (frames[0] && frames[0].opts) || {});
  const kids = new Set();
  let cancelled = false, tail = '';
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
    const fadeIn = Math.max(0, +opts.fadeIn || 0), fadeOutV = Math.max(0, +opts.fadeOut || 0);
    try { fs.writeFileSync(outPath.replace(/\.[^.\\/]+$/, '') + '_log.txt', 'AutoCut render log\n' + new Date().toISOString() + '\nframes=' + fr.length + ' subs=' + hasSubs + ' transitions=' + hasTr + ' fx=' + hasFx + '\nopts=' + JSON.stringify(Object.assign({}, opts, { blankPng: opts.blankPng ? 'yes' : '' })) + '\nos=' + process.platform + ' tmp=' + os.tmpdir() + '\n', 'utf8'); } catch (_) {}
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autocut_'));
    const aa = audioArgs(opts, audioPath, total, voiceSs);
    try {
      if (!hasFx && !hasTr && !hasSubs) {
        // fast path: one pass, still images through the concat demuxer
        const list = path.join(tmpRoot, 'list.txt');
        fs.writeFileSync(list, buildConcat(fr), 'utf8');
        let vf = FIT + ',fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=5';
        if (fadeIn > 0) vf += ',fade=t=in:st=0:d=' + fadeIn.toFixed(2);
        if (fadeOutV > 0) vf += ',fade=t=out:st=' + Math.max(0, total - fadeOutV).toFixed(3) + ':d=' + fadeOutV.toFixed(2);
        const args = ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, ...aa.inp, '-filter_complex', aa.graph, '-map', '0:v', '-vf', vf, '-map', '[a]',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', outPath];
        await runFf(bin, args, t => {
          tail = (tail + t).slice(-2500);
          const m = [...t.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)].pop();
          if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) / total));
        }, reg);
      } else {
        // every picture becomes a clip with an exact frame count; the clips are joined without re-encoding
        let acc = 0; const counts = [];
        for (const f of fr) { const a0 = Math.round(acc * FPS); acc += f.duration; counts.push(Math.max(1, Math.round(acc * FPS) - a0)); }
        const nFrames = counts.reduce((a, b) => a + b, 0);
        const clips = fr.map((_, i) => path.join(tmpRoot, 'c' + String(i).padStart(4, '0') + '.mp4'));
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
        let done = 0, next = 0;
        const workers = Math.max(1, Math.min(4, (os.cpus() || []).length - 1 || 1));
        const worker = async () => {
          while (next < fr.length && !cancelled) {
            const i = next++, f = fr[i], N = counts[i];
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
              g.push('[' + idx + ':v]' + chain + ',trim=end_frame=' + F + ',setpts=PTS-STARTPTS,fade=t=out:st=0:d=' + (F / FPS).toFixed(3) + ':alpha=1[b0]');
              g.push('[' + cur + '][b0]overlay=0:0:eof_action=pass:format=auto[a1]'); cur = 'a1'; idx++;
            }
            // captions
            if (subLists[i]) {
              args.push('-f', 'concat', '-safe', '0', '-i', subLists[i]);
              g.push('[' + idx + ':v]format=rgba[s0]');
              g.push('[' + cur + '][s0]overlay=0:H-h:eof_action=pass:format=auto[a2]'); cur = 'a2'; idx++;
            }
            // fade from / to black on the first / last clip
            let tailChain = 'format=yuv420p';
            if (i === 0 && fadeIn > 0) tailChain += ',fade=t=in:st=0:d=' + Math.min(fadeIn, N / FPS).toFixed(2);
            if (i === fr.length - 1 && fadeOutV > 0) { const d = Math.min(fadeOutV, N / FPS); tailChain += ',fade=t=out:st=' + (N / FPS - d).toFixed(3) + ':d=' + d.toFixed(2); }
            g.push('[' + cur + ']' + tailChain + '[vout]');
            args.push('-filter_complex', g.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', '-frames:v', String(N), clips[i]);
            await runFf(bin, args, null, reg);
            done++; if (onProgress) onProgress(0.92 * done / fr.length);
          }
        };
        await Promise.all(Array.from({ length: workers }, worker));
        if (cancelled) throw new Error('cancelled');
        const list = path.join(tmpRoot, 'clips.txt');
        fs.writeFileSync(list, clips.map(c => "file '" + esc(c) + "'").join('\n') + '\n', 'utf8');
        const dur = nFrames / FPS;
        const aa2 = audioArgs(opts, audioPath, dur, voiceSs);
        await runFf(bin, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, ...aa2.inp, '-filter_complex', aa2.graph, '-map', '0:v', '-map', '[a]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', dur.toFixed(3), '-movflags', '+faststart', outPath], t => {
          const m = [...t.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)].pop();
          if (m && onProgress) onProgress(Math.min(1, 0.92 + 0.08 * (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) / dur));
        }, reg);
      }
      if (cancelled) throw new Error('cancelled');
      if (onProgress) onProgress(1);
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

module.exports = { renderVideo, buildConcat, ffmpegPath, fitFrames, fxFilter, buildSrt };
