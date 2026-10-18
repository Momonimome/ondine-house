// Regenerate frames/ and frames-mobile/ from the source video with FFmpeg.
//   node test/extract-frames.js path/to/video.mp4
// Set FFMPEG_PATH if ffmpeg is not on PATH. js/app.js expects 121 desktop and 90 mobile frames;
// a different video needs FRAME_COUNT there updated to match.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const video = process.argv[2];
if (!video) {
  console.error('usage: node test/extract-frames.js path/to/video.mp4');
  process.exit(1);
}
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFMPEG_PATH ? path.join(path.dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe';

const duration = Number(
  execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString().trim(),
);

const sets = [
  // desktop: every source frame (24 fps, 5.04 s → 121), 1280 px wide
  { dir: 'frames', filter: 'scale=1280:-2:flags=lanczos', quality: 82, extra: [] },
  // mobile: 90 evenly spaced frames, 960 px wide
  { dir: 'frames-mobile', filter: `fps=90/${duration},scale=960:-2:flags=lanczos`, quality: 78, extra: ['-frames:v', '90'] },
];

for (const s of sets) {
  const out = path.join(ROOT, s.dir);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  execFileSync(ffmpeg, ['-v', 'error', '-i', video, '-vf', s.filter, ...s.extra,
    '-c:v', 'libwebp', '-quality', String(s.quality), '-compression_level', '6', path.join(out, 'frame_%04d.webp')], { stdio: 'inherit' });
  console.log(`${s.dir}: ${fs.readdirSync(out).length} frames`);
}
