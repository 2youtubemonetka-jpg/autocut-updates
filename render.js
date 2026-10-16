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

// frames: [{path, duration}], audioPath, outPath, onProgress(0..1)
function renderVideo({ frames, audioPath, outPath, onProgress, ffmpeg }) {
  const bin = ffmpeg || ffmpegPath();
  const total = frames.reduce((s, f) => s + f.duration, 0);
  const list = path.join(os.tmpdir(), 'autocut_' + Date.now() + '.txt');
  fs.writeFileSync(list, buildConcat(frames), 'utf8');
  const args = ['-y', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', list, '-i', audioPath,
    '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-tune', 'stillimage',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outPath];
  let child, tail = '', cancelled = false;
  const promise = new Promise((resolve, reject) => {
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
      if (code === 0) { if (onProgress) onProgress(1); resolve(outPath); }
      else reject(new Error('ffmpeg exit ' + code + '\n' + tail));
    });
  });
  return { promise, cancel: () => { cancelled = true; if (child) child.kill(); } };
}

module.exports = { renderVideo, buildConcat, ffmpegPath };
