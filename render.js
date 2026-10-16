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
function probeAudio(bin, audioPath, setChild) {
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
  const out = frames.map(f => ({ path: f.path, duration: f.duration }));
  if (!audioLen || !out.length) return out;
  let before = 0;
  for (let i = 0; i < out.length - 1; i++) before += out[i].duration;
  if (audioLen - before >= 0.04) out[out.length - 1].duration = audioLen - before;
  return out;
}

// frames: [{path, duration}], audioPath, outPath, onProgress(0..1)
function renderVideo({ frames, audioPath, outPath, onProgress, ffmpeg }) {
  const bin = ffmpeg || ffmpegPath();
  let child, tail = '', cancelled = false;
  const promise = (async () => {
    if (onProgress) onProgress(0);
    const audioLen = await probeAudio(bin, audioPath, c => { child = c; });
    if (cancelled) throw new Error('cancelled');
    const fr = fitFrames(frames, audioLen);
    const total = fr.reduce((s, f) => s + f.duration, 0);
    const list = path.join(os.tmpdir(), 'autocut_' + Date.now() + '.txt');
    fs.writeFileSync(list, buildConcat(fr), 'utf8');
    const args = ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, '-i', audioPath,
      '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=5',
      '-af', 'apad',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-tune', 'stillimage',
      '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), '-movflags', '+faststart', outPath];
    await new Promise((resolve, reject) => {
      child = spawn(bin, args, { windowsHide: true });
      child.stderr.on('data', d => {
        const s = d.toString(); tail = (tail + s).slice(-3000);
        const m = [...s.matchAll(/time=(\d+):(\d+):(\d+\.?\d*)/g)].pop();
        if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])) / total));
      });
      child.on('error', e => { try { fs.unlinkSync(list); } catch (_) {} reject(e); });
      child.on('close', code => {
        try { fs.unlinkSync(list); } catch (_) {}
        if (cancelled) return reject(new Error('cancelled'));
        if (code === 0) { if (onProgress) onProgress(1); resolve(); }
        else reject(new Error('ffmpeg exit ' + code + '\n' + tail));
      });
    });
    return outPath;
  })();
  return { promise, cancel: () => { cancelled = true; if (child) child.kill(); } };
}

module.exports = { renderVideo, buildConcat, ffmpegPath, fitFrames };
