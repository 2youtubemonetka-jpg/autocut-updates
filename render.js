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
function fxFilter(kind, N, zmax) {
  const base = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,scale=3840:2160:flags=lanczos';
  const p = 'on/' + Math.max(1, N - 1);
  const zA = (zmax - 1).toFixed(4);
  const cx = 'iw/2-(iw/zoom/2)', cy = 'ih/2-(ih/zoom/2)';
  let z, x, y = cy;
  if (kind === 'in') { z = '1+' + zA + '*' + p; x = cx; }
  else if (kind === 'out') { z = zmax + '-' + zA + '*' + p; x = cx; }
  else if (kind === 'lr') { z = String(zmax); x = '(iw-iw/zoom)*' + p; }        // camera moves left -> right
  else { z = String(zmax); x = '(iw-iw/zoom)*(1-' + p + ')'; }                    // right -> left
  return base + ",zoompan=z='" + z + "':x='" + x + "':y='" + y + "':d=" + N + ':s=1920x1080:fps=' + FPS + ',format=yuv420p';
}
const PLAIN = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=' + FPS + ',format=yuv420p';

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

// frames: [{path, duration, fx?: 'in'|'out'|'lr'|'rl', zoom?: 1.2}], audioPath, outPath, onProgress(0..1)
function renderVideo({ frames, audioPath, outPath, onProgress, ffmpeg }) {
  const bin = ffmpeg || ffmpegPath();
  const kids = new Set();
  let cancelled = false, tail = '';
  const reg = c => { kids.add(c); c.on('close', () => kids.delete(c)); };
  const promise = (async () => {
    if (onProgress) onProgress(0);
    const audioLen = await probeAudio(bin, audioPath, reg);
    if (cancelled) throw new Error('cancelled');
    const fr = fitFrames(frames, audioLen);
    const total = fr.reduce((s, f) => s + f.duration, 0);
    const hasFx = fr.some(f => f.fx);
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autocut_'));
    try {
      if (!hasFx) {
        // fast path: one pass, still images through the concat demuxer
        const list = path.join(tmpRoot, 'list.txt');
        fs.writeFileSync(list, buildConcat(fr), 'utf8');
        const args = ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, '-i', audioPath,
          '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=5',
          '-af', 'apad', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-tune', 'stillimage',
          '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', outPath];
        await runFf(bin, args, t => {
          tail = (tail + t).slice(-2500);
          const m = [...t.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)].pop();
          if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) / total));
        }, reg);
      } else {
        // every picture becomes a clip with an exact frame count; then the clips are joined without re-encoding
        let acc = 0; const counts = [];
        for (const f of fr) { const a0 = Math.round(acc * FPS); acc += f.duration; counts.push(Math.max(1, Math.round(acc * FPS) - a0)); }
        const nFrames = counts.reduce((a, b) => a + b, 0);
        const clips = fr.map((_, i) => path.join(tmpRoot, 'c' + String(i).padStart(4, '0') + '.mp4'));
        let done = 0, next = 0;
        const workers = Math.max(1, Math.min(4, (os.cpus() || []).length - 1 || 1));
        const worker = async () => {
          while (next < fr.length && !cancelled) {
            const i = next++, f = fr[i], N = counts[i];
            const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an', '-frames:v', String(N), clips[i]];
            const args = (f.fx && N >= 2)
              ? ['-y', '-hide_banner', '-nostats', '-i', f.path, '-vf', fxFilter(f.fx, N, f.zoom || 1.2), ...enc]
              : ['-y', '-hide_banner', '-nostats', '-loop', '1', '-framerate', String(FPS), '-i', f.path, '-vf', PLAIN, ...enc];
            await runFf(bin, args, null, reg);
            done++; if (onProgress) onProgress(0.92 * done / fr.length);
          }
        };
        await Promise.all(Array.from({ length: workers }, worker));
        if (cancelled) throw new Error('cancelled');
        const list = path.join(tmpRoot, 'clips.txt');
        fs.writeFileSync(list, clips.map(c => "file '" + esc(c) + "'").join('\n') + '\n', 'utf8');
        const dur = nFrames / FPS;
        await runFf(bin, ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, '-i', audioPath, '-map', '0:v', '-map', '1:a',
          '-c:v', 'copy', '-af', 'apad', '-c:a', 'aac', '-b:a', '192k', '-t', dur.toFixed(3), '-movflags', '+faststart', outPath], t => {
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

module.exports = { renderVideo, buildConcat, ffmpegPath, fitFrames, fxFilter };
