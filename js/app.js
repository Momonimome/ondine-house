/* ==========================================================================
   Ondine, Bantry Bay — scroll-driven drone approach
   ========================================================================== */
(() => {
  gsap.registerPlugin(ScrollTrigger);

  const isMobile = matchMedia("(max-width: 767px)").matches;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const FRAME_COUNT = isMobile ? 90 : 121;
  const FRAME_DIR = isMobile ? "frames-mobile" : "frames";
  const IMAGE_SCALE = isMobile ? 0.88 : 0.86;
  const PRIORITY_FRAMES = 10;

  /* Scroll progress → video progress.
     The brief ties each section to what the drone is passing, so instead of a
     flat FRAME_SPEED the video follows these keyframes (monotone cubic, so it
     never reverses and every scroll position maps to exactly one frame).
     Video finishes at 84% and the final interior frame holds under the CTA. */
  const VIDEO_KEYS = [
    [0.00, 0.00],  // hero: barely drifting while the circle opens
    [0.20, 0.06],
    [0.33, 0.25],  // the setting: wide cliff, Lion's Head, Atlantic
    [0.47, 0.49],  // outdoor living: approach over the pool
    [0.61, 0.56],  // stats: slow glide along the terrace, under the overlay
    [0.73, 0.74],  // architecture: the curved glass balcony
    [0.84, 1.00],  // interior: through the doors into the living room
    [1.00, 1.00],  // CTA: final frame holds
  ];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp01 = v => Math.min(1, Math.max(0, v));
  const ramp = (p, a, b) => clamp01((p - a) / (b - a));

  const scrollContainer = $("#scroll-container");
  const canvas = $("#canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const canvasWrap = $(".canvas-wrap");
  const hero = $(".hero-standalone");
  const heroInner = $(".hero-inner");
  const scrollCue = $(".scroll-cue");
  const header = $(".site-header");
  const overlay = $("#dark-overlay");
  const scrims = { left: $(".scrim-left"), right: $(".scrim-right"), sand: $(".scrim-sand"), center: $(".scrim-center") };
  const approach = $(".approach");
  const approachFill = $(".approach-fill");
  const approachDot = $(".approach-dot");
  const approachStops = $$(".approach-stops li");
  const sections = $$(".scroll-section");
  approachStops.forEach(li => { li.style.left = (+li.dataset.at * 100) + "%"; });

  /* ---------- monotone cubic (Fritsch–Butland) ---------- */
  const videoCurve = (() => {
    const xs = VIDEO_KEYS.map(k => k[0]), ys = VIDEO_KEYS.map(k => k[1]), n = xs.length;
    const d = [], m = [];
    for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] > 0 ? (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]) : 0;
    return p => {
      p = clamp01(p);
      let i = 0; while (i < n - 2 && p > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (p - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return clamp01((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
                     (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]);
    };
  })();

  /* ---------- 6a. Lenis ---------- */
  let lenis = null;
  if (!reduceMotion) {
    lenis = new Lenis({ duration: 1.2, easing: t => Math.min(1, 1.001 - 2 ** (-10 * t)), smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add(t => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    lenis.stop();                      // locked until every frame is in
  }
  history.scrollRestoration = "manual";
  window.scrollTo(0, 0);

  /* ---------- 6b. Preloader ---------- */
  const frames = new Array(FRAME_COUNT);
  const edgeColors = new Array(FRAME_COUNT);
  const src = i => `${FRAME_DIR}/frame_${String(i + 1).padStart(4, "0")}.webp`;
  const loaderBar = $("#loader-bar"), loaderPct = $("#loader-percent");
  let loaded = 0;

  function loadFrame(i, attempt = 0) {
    return new Promise(resolve => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => {
        (img.decode ? img.decode() : Promise.resolve()).catch(() => {}).then(() => {
          frames[i] = img; edgeColors[i] = sampleEdges(img);
          loaded++;
          const pct = Math.round((loaded / FRAME_COUNT) * 100);
          loaderBar.style.transform = `scaleX(${loaded / FRAME_COUNT})`;
          loaderPct.textContent = pct + "%";
          resolve();
        });
      };
      img.onerror = () => attempt < 2 ? setTimeout(() => loadFrame(i, attempt + 1).then(resolve), 400) : resolve();
      img.src = src(i);
    });
  }

  async function preload() {
    // first ten in order so frame 1 is ready to paint immediately
    await Promise.all(Array.from({ length: PRIORITY_FRAMES }, (_, i) => loadFrame(i)));
    resize();
    let next = PRIORITY_FRAMES;
    const worker = async () => { while (next < FRAME_COUNT) await loadFrame(next++); };
    await Promise.all(Array.from({ length: 6 }, worker));
    // any frame that failed falls back to its nearest neighbour, so there is never a gap
    for (let i = 0; i < FRAME_COUNT; i++) if (!frames[i]) {
      let j = 1; while (!frames[i - j] && !frames[i + j] && j < FRAME_COUNT) j++;
      frames[i] = frames[i - j] || frames[i + j]; edgeColors[i] = edgeColors[i - j] || edgeColors[i + j];
    }
  }

  /* ---------- 6c. Canvas: padded cover, blended frames ---------- */
  const sampler = document.createElement("canvas");
  sampler.width = 32; sampler.height = 18;
  const sctx = sampler.getContext("2d", { willReadFrequently: true });

  // Average of the frame's outer ring, deepened toward charcoal so the fill reads as a matte.
  function sampleEdges(img) {
    sctx.drawImage(img, 0, 0, 32, 18);
    const px = sctx.getImageData(0, 0, 32, 18).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) {
      if (x > 1 && x < 30 && y > 1 && y < 16) continue;
      const k = (y * 32 + x) * 4; r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
    }
    const mix = 0.55, base = [21, 20, 18];
    return [r / n, g / n, b / n].map((c, i) => c * (1 - mix) + base[i] * mix);
  }

  let cw = 0, ch = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.round(innerWidth * dpr); ch = Math.round(innerHeight * dpr);
    canvas.width = cw; canvas.height = ch;
    ctx.imageSmoothingQuality = "high";
    drawnFrame = -1;
    render(true);
  }

  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  function drawFrame(f) {
    const i = Math.floor(f), t = f - i;
    const a = frames[i], b = frames[Math.min(i + 1, FRAME_COUNT - 1)];
    if (!a) return;
    const ca = edgeColors[i], cb = edgeColors[Math.min(i + 1, FRAME_COUNT - 1)] || ca;
    const bg = ca.map((v, k) => v + (cb[k] - v) * t);

    const s = Math.max(cw / a.naturalWidth, ch / a.naturalHeight) * IMAGE_SCALE;
    const dw = a.naturalWidth * s, dh = a.naturalHeight * s;
    const dx = (cw - dw) / 2, dy = (ch - dh) / 2;

    // bilinear is indistinguishable when upscaling and ~3× cheaper than "high"
    ctx.imageSmoothingQuality = s >= 0.98 ? "low" : "high";
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgba(bg, 1);
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(a, dx, dy, dw, dh);
    if (t > 0.002 && b && b !== a) {    // sub-frame crossfade: 121 frames glide like thousands
      ctx.globalAlpha = t;
      ctx.drawImage(b, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    }

    // feather the frame into the matte
    const fx = Math.min(dw * 0.07, 140 * dpr), fy = Math.min(dh * 0.09, 120 * dpr);
    const solid = rgba(bg, 1), clear = rgba(bg, 0);
    const band = (x0, y0, x1, y1, rx, ry, rw, rh) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, solid); g.addColorStop(1, clear);
      ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh);
    };
    if (dx > -fx) band(dx, 0, dx + fx, 0, dx, dy, fx, dh);
    if (dx + dw < cw + fx) band(dx + dw, 0, dx + dw - fx, 0, dx + dw - fx, dy, fx, dh);
    if (dy > -fy) band(0, dy, 0, dy + fy, dx, dy, dw, fy);
    if (dy + dh < ch + fy) band(0, dy + dh, 0, dy + dh - fy, dx, dy + dh - fy, dw, fy);
  }

  /* ---------- 6d. Scroll → frame ---------- */
  let progress = 0, drawnFrame = -1;
  const frameAt = p => videoCurve(p) * (FRAME_COUNT - 1);

  function render(force) {
    const f = frameAt(progress);
    // exact comparison: a threshold would leave the last sliver of an ease-out undrawn, so the same
    // scroll position could show a fractionally different image depending on how you arrived
    if (force || f !== drawnFrame) { drawFrame(f); drawnFrame = f; }
    // signature gauge follows the drone, not the page
    const v = videoCurve(progress);
    approachFill.style.transform = `scaleX(${v})`;
    approachDot.style.left = (v * 100) + "%";
    approachStops.forEach((li, k) => {
      const next = approachStops[k + 1];
      li.classList.toggle("is-active", v >= +li.dataset.at - 0.001 && (!next || v < +next.dataset.at));
    });
  }
  // Draw on the ticker so the canvas updates exactly once per display frame.
  gsap.ticker.add(() => render(false));

  /* ---------- 6e. Sections ---------- */
  const ANIMS = {
    "slide-left":  { from: { x: -80 }, to: { x: 0 }, duration: 0.95, stagger: 0.14, ease: "power3.out" },
    "clip-reveal": { from: { y: 24, clipPath: "inset(100% -20% -20% -20%)" }, to: { y: 0, clipPath: "inset(-20% -20% -20% -20%)" }, duration: 1.15, stagger: 0.13, ease: "power4.out" },
    "scale-up":    { from: { scale: 0.86 }, to: { scale: 1 }, duration: 1.0, stagger: 0.12, ease: "power2.out" },
    "slide-right": { from: { x: 80 }, to: { x: 0 }, duration: 0.95, stagger: 0.14, ease: "power3.out" },
    "rotate-in":   { from: { y: 46, rotation: 3, transformOrigin: "0% 100%" }, to: { y: 0, rotation: 0 }, duration: 0.95, stagger: 0.11, ease: "power3.out" },
    "clip-left":   { from: { clipPath: "inset(-20% 100% -20% -20%)" }, to: { clipPath: "inset(-20% -20% -20% -20%)" }, duration: 1.2, stagger: 0.14, ease: "power4.inOut" },
  };
  const REDUCED = { from: {}, to: {}, duration: 0.4, stagger: 0.06, ease: "none" };
  const CHILDREN = ".section-label, .section-heading, .section-body, .section-note, .cta-button, .stat";

  const counters = $$(".stat-number").map(el => ({ el, value: +el.dataset.value, decimals: +el.dataset.decimals || 0, tween: null }));
  const fmt = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  counters.forEach(c => { c.el.textContent = fmt(0, c.decimals); });

  function runCounters(on) {
    counters.forEach((c, k) => {
      c.tween && c.tween.kill();
      if (!on) { c.el.textContent = fmt(0, c.decimals); return; }
      if (reduceMotion) { c.el.textContent = fmt(c.value, c.decimals); return; }
      const o = { v: 0 };
      c.tween = gsap.to(o, {
        v: c.value, duration: 2, delay: 0.25 + k * 0.12, ease: "power1.out",
        onUpdate: () => { c.el.textContent = fmt(c.decimals ? o.v : Math.round(o.v), c.decimals); },
      });
    });
  }

  const sectionState = sections.map(section => {
    const { animation, enter, leave, persist, scrim } = section.dataset;
    const a = reduceMotion ? REDUCED : ANIMS[animation];
    const kids = $$(CHILDREN, section);
    const tl = gsap.timeline({
      paused: true,
      onReverseComplete: () => {
        section.style.visibility = "hidden";
        // reset counters only once the stats have fully faded, so no zeros flash during the exit
        if (section.classList.contains("section-stats")) runCounters(false);
      },
    }).fromTo(kids, { opacity: 0, ...a.from }, { opacity: 1, ...a.to, duration: a.duration, stagger: a.stagger, ease: a.ease });
    section.style.visibility = "hidden";
    return { section, tl, e: enter / 100, l: leave / 100, persist: persist === "true", scrim, shown: false,
             isStats: section.classList.contains("section-stats") };
  });

  function updateSections(p) {
    sectionState.forEach(s => {
      const visible = p >= s.e && (s.persist || p <= s.l);
      if (visible === s.shown) return;
      s.shown = visible;
      s.pending && s.pending.kill();
      if (visible) {
        // if a neighbour is still on its way out, let it clear before this one enters
        const busy = sectionState.some(o => o !== s && o.tl.isActive() && o.tl.reversed());
        s.section.style.visibility = "visible";
        s.pending = gsap.delayedCall(busy ? 0.3 : 0, () => s.tl.timeScale(1).play());
      } else if (s.tl.time() === 0) {
        s.section.style.visibility = "hidden";     // left before its entrance began
      } else {
        s.tl.timeScale(2.4).reverse();             // exits are quicker than entrances
      }
      if (s.isStats && visible) runCounters(true);
    });
  }

  /* ---------- scrims: fade in just ahead of their section's text ---------- */
  function updateScrims(p) {
    const o = { left: 0, right: 0, sand: 0 };
    sectionState.forEach(s => {
      if (!(s.scrim in o)) return;
      const v = ramp(p, s.e - 0.025, s.e - 0.005) * (s.persist ? 1 : 1 - ramp(p, s.l, s.l + 0.025));
      o[s.scrim] = Math.max(o[s.scrim], v);
    });
    scrims.left.style.opacity = o.left;
    scrims.right.style.opacity = o.right;
    scrims.sand.style.opacity = o.sand;
    scrims.center.style.opacity = Math.max(o.left, o.right);
  }

  /* ---------- 6g. Marquee (slides across its own range) ---------- */
  const marquees = $$(".marquee-wrap").map(el => ({
    el, text: $(".marquee-text", el),
    e: +el.dataset.enter / 100, l: +el.dataset.leave / 100, speed: +el.dataset.scrollSpeed || -25,
  }));
  function updateMarquees(p) {
    marquees.forEach(m => {
      const fade = 0.025;
      m.el.style.opacity = ramp(p, m.e, m.e + fade) * (1 - ramp(p, m.l - fade, m.l));
      if (!reduceMotion) m.text.style.transform = `translate3d(${ramp(p, m.e, m.l) * m.speed}%,0,0)`;
    });
  }

  /* ---------- 6h. Dark overlay ---------- */
  const STATS = sectionState.find(s => s.isStats);
  function updateOverlay(p, fade = 0.03) {
    const { e, l } = STATS;
    let o = 0;
    if (p >= e - fade && p < e) o = 0.9 * (p - e + fade) / fade;
    else if (p >= e && p <= l) o = 0.9;
    else if (p > l && p <= l + fade) o = 0.9 * (1 - (p - l) / fade);
    overlay.style.opacity = o;
  }

  /* ---------- 6i. Circle-wipe hero reveal ---------- */
  function updateHero(p) {
    const fade = ramp(p, 0.012, 0.085);
    heroInner.style.opacity = 1 - fade;
    heroInner.style.transform = reduceMotion ? "" : `translate3d(0,${-fade * 7}vh,0) scale(${1 - fade * 0.04})`;
    scrollCue.style.opacity = 1 - ramp(p, 0.004, 0.03);
    const t = ramp(p, 0.02, 0.15), r = (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2) * 75;
    canvasWrap.style.clipPath = r >= 75 ? "none" : `circle(${r}% at 50% 50%)`;
    hero.style.visibility = r >= 75 ? "hidden" : "visible";
    header.classList.toggle("on-dark", p > 0.07);
    header.classList.toggle("on-sand", p >= sectionState.at(-1).e - 0.01);
    approach.classList.toggle("is-on", p > 0.15 && p < 0.86);
  }

  /* ---------- master scroll driver ---------- */
  function onProgress(p) {
    progress = p;
    updateHero(p); updateSections(p); updateScrims(p); updateMarquees(p); updateOverlay(p);
  }

  /* ---------- nav ---------- */
  const GOTO = { 0: 0, setting: 0.26, residence: 0.54, interior: 0.79, viewing: 1 };
  $$("[data-goto]").forEach(a => a.addEventListener("click", ev => {
    ev.preventDefault();
    const range = scrollContainer.offsetHeight - innerHeight;
    const y = GOTO[a.dataset.goto] * range;
    lenis ? lenis.scrollTo(y, { duration: 2.4 }) : window.scrollTo(0, y);
  }));

  /* ---------- boot ---------- */
  function heroIntro() {
    const words = $$(".hero-heading .word-inner");
    const rest = [$(".hero-label"), $(".hero-tagline"), scrollCue];
    if (reduceMotion) { gsap.from([...words, ...rest], { opacity: 0, duration: 0.6, stagger: 0.05 }); return; }
    gsap.timeline({ delay: 0.2 })
      .from(".hero-label", { opacity: 0, y: 16, duration: 0.9, ease: "power3.out" })
      .from(words, { yPercent: 112, duration: 1.4, stagger: 0.12, ease: "expo.out" }, "-=0.55")
      .from(".hero-tagline", { opacity: 0, y: 20, duration: 1, ease: "power3.out" }, "-=0.95")
      .from(scrollCue, { opacity: 0, duration: 1 }, "-=0.6");
  }

  preload().then(() => document.fonts.ready).then(() => {
    ScrollTrigger.create({
      trigger: scrollContainer, start: "top top", end: "bottom bottom",
      onUpdate: self => onProgress(self.progress),
      onRefresh: self => onProgress(self.progress),
    });
    ScrollTrigger.refresh();
    onProgress(0);
    render(true);
    requestAnimationFrame(() => {
      $("#loader").classList.add("is-done");
      document.body.classList.remove("is-loading");
      lenis && lenis.start();
      heroIntro();
    });
  });

  let resizeTimer;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); ScrollTrigger.refresh(); }, 120);
  });

  if (new URLSearchParams(location.search).has("debug")) {
    window.__ondine = { lenis, frameAt, draw: f => { drawFrame(f); drawnFrame = -1; }, get frame() { return drawnFrame; }, get progress() { return progress; }, get loaded() { return loaded; }, FRAME_COUNT };
  }
})();
