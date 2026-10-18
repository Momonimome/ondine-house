// Regenerate the images in docs/: two screenshots, a social preview card, and a
// scroll-through preview as animated WebP (for the README) and MP4 (for sharing).
//   node test/screenshots.js
// The WebP and MP4 need FFmpeg; set FFMPEG_PATH if it is not on PATH.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.js';
import { serve } from './server.js';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const { port, close: stopServer } = await serve(0);
fs.mkdirSync(DOCS, { recursive: true });

async function open(cfg) {
  const b = await launch(cfg);
  await b.send('Page.navigate', { url: `http://127.0.0.1:${port}/?debug` });
  while (!(await b.evaluate(`!!document.querySelector('#loader.is-done')`))) await sleep(150);
  await sleep(2600); // hero entrance
  b.goto = async (p, settle = 2600) => {
    await b.evaluate(`(() => { const o = window.__ondine, r = document.getElementById('scroll-container').offsetHeight - innerHeight;
      o.lenis ? o.lenis.scrollTo(${p} * r, { immediate: true, force: true }) : window.scrollTo(0, ${p} * r); })()`);
    await sleep(settle);
  };
  return b;
}

// ---- stills
{
  const b = await open({ width: 1440, height: 900 });
  await b.goto(0.4);
  await b.screenshot(path.join(DOCS, 'screenshot.png'));
  b.close();
}
{
  const b = await open({ width: 390, height: 844, dpr: 2, mobile: true });
  await b.goto(0.26);
  await b.screenshot(path.join(DOCS, 'screenshot-mobile.png'));
  b.close();
}
{
  const b = await open({ width: 1280, height: 640 });
  await b.goto(0.07, 1200); // the circle wipe opening over the name
  await b.screenshot(path.join(DOCS, 'social-preview.png'));
  b.close();
}
console.log('docs: screenshot.png, screenshot-mobile.png, social-preview.png');

// ---- scroll-through preview, recorded with the DevTools screencast
const b = await open({ width: 1280, height: 800 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ondine-cast-'));
const shots = [];
b.on((m) => {
  if (m.method !== 'Page.screencastFrame') return;
  const file = path.join(tmp, `f${String(shots.length).padStart(5, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(m.params.data, 'base64'));
  shots.push({ file, t: m.params.metadata.timestamp });
  b.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
});
await b.send('Page.startScreencast', { format: 'jpeg', quality: 88, everyNthFrame: 1 });
await sleep(1200);
// glide to each section, hold while its text reveals
const tour = [[0.26, 3.2, 1.6], [0.4, 2.4, 1.6], [0.54, 2.2, 2.6], [0.67, 2.2, 1.6], [0.79, 2.2, 1.6], [1, 2.6, 2.6]];
for (const [p, duration, hold] of tour) {
  await b.evaluate(`new Promise((done) => { const r = document.getElementById('scroll-container').offsetHeight - innerHeight;
    window.__ondine.lenis.scrollTo(${p} * r, { duration: ${duration}, easing: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2), onComplete: () => done() }); })`);
  await sleep(hold * 1000);
}
await b.send('Page.stopScreencast');
b.close();
stopServer();

// concat list with each frame's real on-screen duration
const list = shots.map((s, i) => `file '${s.file.replace(/\\/g, '/')}'\nduration ${((shots[i + 1]?.t ?? s.t + 0.04) - s.t).toFixed(4)}`);
list.push(`file '${shots.at(-1).file.replace(/\\/g, '/')}'`);
const listFile = path.join(tmp, 'list.txt');
fs.writeFileSync(listFile, list.join('\n'));
const span = shots.at(-1).t - shots[0].t;
console.log(`recorded ${shots.length} frames over ${span.toFixed(1)} s (${(shots.length / span).toFixed(1)} fps)`);

const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...args], { stdio: 'inherit' });
// Kept small on purpose (about 1 MB each): GitHub pages load faster and slow uploads finish.
// Animated WebP is a fraction of the size of an equivalent GIF and GitHub renders it in READMEs.
run(['-vf', 'fps=30,scale=960:-2:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-crf', '28', '-preset', 'slow', '-movflags', '+faststart', path.join(DOCS, 'preview.mp4')]);
run(['-vf', 'setpts=PTS/1.5,fps=12,scale=800:-1:flags=lanczos', '-c:v', 'libwebp_anim', '-quality', '65', '-compression_level', '6', '-loop', '0', path.join(DOCS, 'preview.webp')]);
fs.rmSync(tmp, { recursive: true, force: true });
for (const f of ['preview.mp4', 'preview.webp']) console.log(`docs/${f}: ${(fs.statSync(path.join(DOCS, f)).size / 1048576).toFixed(1)} MB`);
