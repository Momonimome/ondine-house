// End-to-end scroll test in headless Chrome. No dependencies.
//   node test/scroll.test.js                 all four profiles
//   node test/scroll.test.js desktop mobile  only those
//
// For each profile it checks that:
//   - the loader stays up until every frame has decoded
//   - real wheel input never moves the video backwards while scrolling down, or forwards while scrolling up
//   - every position sampled on the way down renders pixel-identical when revisited on the way up
//   - each section reveals with an entrance animation, counters reach their values, the CTA persists
//   - every visible text block passes WCAG AA against the actual pixels behind it
//   - there is no horizontal overflow and no console error
import { launch, sleep } from './cdp.js';
import { serve } from './server.js';

const PROFILES = {
  desktop: { width: 1440, height: 900, dpr: 1, wheel: true },
  mobile: { width: 390, height: 844, dpr: 2, mobile: true },
  narrow: { width: 375, height: 667, dpr: 2, mobile: true },
  reduced: { width: 1440, height: 900, dpr: 1, reducedMotion: true, wheel: true },
};
const CHECKPOINTS = [
  ['setting', 0.26], ['outdoor', 0.4], ['residence', 0.54], ['architecture', 0.67],
  ['interior', 0.79], ['viewing', 0.94], ['viewing', 1],
];

const selected = process.argv.slice(2).filter((a) => a in PROFILES);
const { port, close: stopServer } = await serve(0);
let failures = 0;

for (const name of selected.length ? selected : Object.keys(PROFILES)) {
  const cfg = PROFILES[name];
  const results = [];
  const check = (label, ok, detail = '') => { results.push({ label, ok, detail }); if (!ok) failures++; };
  console.log(`\n${name} (${cfg.width}x${cfg.height}${cfg.reducedMotion ? ', reduced motion' : ''})`);

  const b = await launch(cfg);
  const ev = b.evaluate;
  try {
    await b.send('Page.navigate', { url: `http://127.0.0.1:${port}/?debug` });

    // ---- loader
    const t0 = Date.now();
    let sawPartial = false;
    let state;
    for (;;) {
      state = await ev(`(() => { const o = window.__ondine; return { done: document.getElementById('loader').classList.contains('is-done'), loaded: o ? o.loaded : 0, n: o ? o.FRAME_COUNT : 0 }; })()`);
      if (!state.done && state.loaded > 0 && state.loaded < state.n) sawPartial = true;
      if (state.done || Date.now() - t0 > 90_000) break;
      await sleep(100);
    }
    check('loader hides only after every frame is loaded', state.done && state.loaded === state.n,
      `${state.loaded}/${state.n} frames, ${Date.now() - t0} ms${sawPartial ? ', loader seen mid-load' : ''}`);
    await sleep(2600);

    const range = await ev(`document.getElementById('scroll-container').offsetHeight - innerHeight`);
    await ev(`(() => {
      const c = document.getElementById('canvas'); const x = c.getContext('2d');
      window.__hash = () => { const d = x.getImageData(0, 0, c.width, c.height).data; let h = 2166136261 >>> 0;
        for (let i = 0; i < d.length; i += 3) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; } return h; };
      window.__settle = () => new Promise((res) => { let last = -1, still = 0; const tick = () => {
        const y = window.scrollY; still = Math.abs(y - last) < 0.5 ? still + 1 : 0; last = y;
        still > 12 ? requestAnimationFrame(() => requestAnimationFrame(res)) : requestAnimationFrame(tick); }; tick(); });
      window.__log = []; window.__logging = false;
      const loop = (t) => { if (window.__logging) window.__log.push(window.__ondine.frame); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      window.__jump = (y) => { const L = window.__ondine.lenis; L ? L.scrollTo(y, { immediate: true, force: true }) : window.scrollTo(0, y); };
      // Chrome moves a canvas to a CPU backing store after repeated readbacks; do that now so every sample uses one path.
      // Then redraw, so the frame painted at boot (on the GPU path) is not compared with later CPU-path redraws.
      for (let i = 0; i < 6; i++) window.__hash();
      window.__ondine.draw(window.__ondine.frame);
    })()`);
    const sample = () => ev(`(async () => { await window.__settle(); return { y: Math.round(scrollY), f: window.__ondine.frame, h: window.__hash() }; })()`);

    // ---- forward and reverse with real wheel input
    const down = [];
    if (cfg.wheel) {
      await ev('window.__log = []; window.__logging = true');
      for (let k = 0; k < 400; k++) {
        await b.wheel(110);
        await sleep(55);
        if (k % 6 === 5) { await ev('window.__logging = false'); down.push(await sample()); await ev('window.__logging = true'); }
        if (await ev(`scrollY >= ${range - 1}`)) break;
      }
      await ev('window.__logging = false');
      down.push(await sample());
      const fwd = await ev('window.__log');
      const backwards = fwd.filter((f, i) => i && f < fwd[i - 1] - 1e-9).length;
      const steps = fwd.slice(1).map((f, i) => Math.abs(f - fwd[i])).sort((a, c) => a - c);
      check('scrolling down never plays the video backwards', backwards === 0,
        `${fwd.length} display frames; median step ${steps[steps.length >> 1].toFixed(2)} frames, p95 ${steps[Math.floor(steps.length * 0.95)].toFixed(2)}`);
      check('scrolling down reaches the final frame', down.at(-1).f === state.n - 1, `frame ${down.at(-1).f}`);

      await ev('window.__log = []; window.__logging = true');
      for (let k = 0; k < 400; k++) { await b.wheel(-110); await sleep(55); if (await ev('scrollY <= 0')) break; }
      await ev('window.__logging = false');
      const back = await ev('window.__log');
      const forwards = back.filter((f, i) => i && f > back[i - 1] + 1e-9).length;
      const end = await sample();
      check('scrolling up never plays the video forwards', forwards === 0, `${back.length} display frames`);
      check('scrolling up returns to the first frame', end.f === 0, `frame ${end.f}`);
    } else {
      for (let k = 0; k <= 40; k++) { await ev(`window.__jump(${Math.round((range * k) / 40)})`); down.push(await sample()); }
    }

    // ---- frame for frame: every forward position, revisited in reverse order
    const mismatches = [];
    for (const s of [...down].reverse()) {
      await ev(`window.__jump(${s.y})`);
      const r = await sample();
      if (r.y !== s.y) mismatches.push(`y=${s.y}: landed at ${r.y}`);
      else if (r.f !== s.f) mismatches.push(`y=${s.y}: frame ${s.f} vs ${r.f}`);
      else if (r.h !== s.h) mismatches.push(`y=${s.y}: same frame ${s.f.toFixed(3)}, different pixels`);
    }
    check('reverse matches forward frame for frame', mismatches.length === 0,
      `${down.length} positions, ${mismatches.length} mismatches${mismatches.length ? `: ${mismatches.join('; ')}` : ''}`);
    check('frame index never decreases as scroll increases', down.every((s, i) => !i || s.f >= down[i - 1].f));

    // ---- sections
    await ev(`(() => { const s = document.createElement('style'); s.textContent =
      '.ct-hide .scroll-section, .ct-hide .site-header a, .ct-hide .approach-stops { visibility: hidden !important; }';
      document.head.appendChild(s); })()`);
    for (const [id, p] of CHECKPOINTS) {
      const enter = await ev(`+document.getElementById('${id}').dataset.enter / 100`);
      await ev('window.__jump(0)'); await sample(); await sleep(400);
      await ev(`window.__jump(${Math.round(range * (enter - 0.03))})`); await sample(); await sleep(1200);
      await ev(`window.__jump(${Math.round(range * p)})`); await sample();
      await sleep(160);
      const moving = await ev(`[...document.querySelectorAll('#${id} .section-heading, #${id} .section-body, #${id} .stat, #${id} .cta-button')]
        .filter((e) => { const cs = getComputedStyle(e); return +cs.opacity < 0.99 || (cs.transform !== 'none' && cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)') || (cs.clipPath !== 'none' && !cs.clipPath.startsWith('inset(-20%')); }).length`);
      await sleep(id === 'residence' ? 3200 : 2400);
      const visible = await ev(`[...document.querySelectorAll('.scroll-section')].filter((s) => getComputedStyle(s).visibility === 'visible'
        && [...s.querySelectorAll('.section-heading, .stat')].some((e) => +getComputedStyle(e).opacity > 0.98)).map((s) => s.id)`);
      const tag = `${id} @ ${p}`;
      check(`${tag}: only this section is showing`, visible.length === 1 && visible[0] === id, visible.join(', ') || 'none');
      if (p < 1) check(`${tag}: entrance animation plays`, moving > 0, `${moving} elements mid-animation after 160 ms`);
      if (id === 'residence') {
        const counters = await ev(`[...document.querySelectorAll('.stat-number')].map((e) => [e.textContent, (+e.dataset.value).toLocaleString('en-US')])`);
        check(`${tag}: counters reach their values`, counters.every(([a, b2]) => a === b2), counters.map((c) => c[0]).join(' | '));
      }

      // contrast against the real pixels: screenshot with the text hidden, then compare each text box
      const boxes = await ev(`(() => {
        const sel = '.scroll-section .section-label, .scroll-section .section-heading, .scroll-section .section-body:not(.price), .scroll-section .section-note, .stat-number, .stat-suffix, .stat-label, .price-label, .price-value, .agent-name, .agent-role, .agent a, .site-header .wordmark, .site-nav a:not(.nav-cta), .logo-sub, .approach-stops li';
        return [...document.querySelectorAll(sel)].filter((e) => { if (getComputedStyle(e).display === 'none') return false;
          for (let n = e; n && n !== document.body; n = n.parentElement) { const s = getComputedStyle(n); if (s.visibility === 'hidden' || +s.opacity < 0.98) return false; } return true; })
        .map((e) => { const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect(); const cs = getComputedStyle(e);
          const px = parseFloat(cs.fontSize), w = +cs.fontWeight;
          return { name: (e.textContent || '').trim().slice(0, 28), x: b.left, y: b.top, w: b.width, h: b.height,
            c: cs.color.match(/[\\d.]+/g).slice(0, 3).map(Number), need: px >= 24 || (px >= 18.66 && w >= 700) ? 3 : 4.5 }; })
        .filter((b) => b.w > 2 && b.h > 2 && b.y < innerHeight && b.y + b.h > 0);
      })()`);
      await ev(`document.documentElement.classList.add('ct-hide')`);
      await sleep(80);
      const bg = await b.screenshot();
      await ev(`document.documentElement.classList.remove('ct-hide')`);
      const ratios = await ev(`(async () => {
        const img = new Image(); img.src = 'data:image/png;base64,${bg}'; await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0); const k = c.width / innerWidth;
        const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        return ${JSON.stringify(boxes)}.map((b) => {
          const x0 = Math.max(0, Math.floor(b.x * k)), y0 = Math.max(0, Math.floor(b.y * k));
          const d = x.getImageData(x0, y0, Math.min(c.width - x0, Math.ceil(b.w * k)), Math.min(c.height - y0, Math.ceil(b.h * k))).data;
          const ls = []; for (let i = 0; i < d.length; i += 4) ls.push(L(d[i], d[i + 1], d[i + 2])); ls.sort((p, q) => p - q);
          const lt = L(...b.c); const worst = lt > 0.4 ? ls[Math.floor(ls.length * 0.99)] : ls[Math.floor(ls.length * 0.01)];
          return { name: b.name, need: b.need, ratio: (Math.max(lt, worst) + 0.05) / (Math.min(lt, worst) + 0.05) };
        });
      })()`);
      const failing = ratios.filter((r) => r.ratio < r.need);
      const tightest = ratios.reduce((m, r) => (r.ratio / r.need < m.ratio / m.need ? r : m), { ratio: 99, need: 1, name: '' });
      check(`${tag}: all text passes WCAG AA`, failing.length === 0,
        failing.length ? failing.map((f) => `"${f.name}" ${f.ratio.toFixed(2)}:1`).join('; ')
          : `${ratios.length} blocks, tightest ${tightest.ratio.toFixed(2)}:1 ("${tightest.name}")`);
    }

    // ---- CTA persists at the very bottom
    const cta = await ev(`(async () => { window.__jump(${range}); await window.__settle(); await new Promise((r) => setTimeout(r, 1500));
      const btn = document.querySelector('#viewing .cta-button'); const r = btn.getBoundingClientRect();
      return { shown: getComputedStyle(btn).opacity === '1', inView: r.top >= 0 && r.bottom <= innerHeight, frame: window.__ondine.frame }; })()`);
    check('CTA stays on screen over the final frame', cta.shown && cta.inView && cta.frame === state.n - 1, `frame ${cta.frame}`);
    check('no horizontal overflow', (await ev('document.documentElement.scrollWidth - innerWidth')) <= 0);
    check('no console errors', b.errors.length === 0, b.errors.join('; '));
  } catch (err) {
    check('run completed', false, err.message);
  } finally {
    b.close();
  }
  for (const r of results) console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.label}${r.detail ? `  (${r.detail})` : ''}`);
}

stopServer();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
