/* Spectri — live microphone spectrogram.
 * Vanilla Web Audio API + Canvas 2D. No dependencies, no build step. */
(() => {
  'use strict';

  // ---- Defaults (single source of truth) ----
  // Every default value lives here. The DOM controls carry no `value`/`selected`
  // attributes — `initControls()` writes these into both the inputs and `state`
  // on load, so changing a default only ever needs an edit in this object.
  const DEFAULTS = {
    fft: '4096', color: 'jet', log: false,
    floor: -95, ceil: -40, smooth: 0.2, speed: 2, gamma: 1.4,
    fmin: 20, fmax: 5000, mode: 'classic',
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const playBtn = $('playBtn');
  const clearBtn = $('clearBtn');
  const menuBtn = $('menuBtn');
  const closeBtn = $('closeBtn');
  const deviceSelect = $('deviceSelect');
  const fftSelect = $('fftSelect');
  const colorSelect = $('colorSelect');
  const logToggle = $('logToggle');
  const modeSelect = $('modeSelect');
  const immersiveBtn = $('immersiveBtn');
  const minFreqInput = $('minFreq');
  const maxFreqInput = $('maxFreq');
  const floorRange = $('floorRange');
  const ceilRange = $('ceilRange');
  const smoothRange = $('smoothRange');
  const contrastRange = $('contrastRange');
  const speedRange = $('speedRange');
  const floorVal = $('floorVal');
  const ceilVal = $('ceilVal');
  const smoothVal = $('smoothVal');
  const contrastVal = $('contrastVal');
  const speedVal = $('speedVal');
  const canvas = $('spectrogram');
  const axisCanvas = $('freqAxis');
  const overlay = $('overlay');
  const statusEl = $('status');

  const ctx = canvas.getContext('2d', { alpha: false });
  const axisCtx = axisCanvas.getContext('2d');

  // ---- State (tunable fields seeded from DEFAULTS) ----
  const state = {
    audioCtx: null,
    analyser: null,
    source: null,
    stream: null,
    freqData: null,      // Float32Array (dB)
    running: false,
    paused: false,
    rafId: 0,
    lastT: 0,            // previous rAF timestamp (ms); 0 = no reference frame
    acc: 0,              // fractional device pixels of scroll not yet drawn
    lut: null,
    floor: DEFAULTS.floor,
    ceil: DEFAULTS.ceil,
    speed: DEFAULTS.speed,
    gamma: DEFAULTS.gamma,
    log: DEFAULTS.log,
    colormap: DEFAULTS.color,
    fmin: DEFAULTS.fmin,  // displayed min frequency (Hz)
    fmax: DEFAULTS.fmax,  // displayed max frequency (Hz)
    mode: DEFAULTS.mode,  // 'classic' (scrolling spectrogram) | 'galaxy' (art)
  };

  // ---- Art mode runtime (radial galaxy) ----
  // The feedback trail lives on its own canvas pair: the main ctx keeps
  // imageSmoothingEnabled=false for the classic pixel-exact scroll blit, while
  // the feedback zoom needs smoothing ON to resample cleanly. Art mode only
  // ever blits 1:1 onto the main canvas, so the two modes never share state.
  const art = {
    front: null, back: null, // {cv, c2d} feedback ping-pong pair
    strip: null,             // alpha canvas holding one spoke texture (rim→core)
    stripCtx: null,
    angle: 0,                // accumulated spoke rotation (rad)
    energy: 0, bass: 0,      // smoothed 0..1 loudness detectors
  };

  // ---- Colormaps (piecewise-linear control points) ----
  const COLORMAPS = {
    viridis: [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]],
    magma: [[0, 0, 0, 4], [0.25, 81, 18, 124], [0.5, 183, 55, 121], [0.75, 252, 137, 97], [1, 252, 253, 191]],
    inferno: [[0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84], [0.75, 249, 142, 9], [1, 252, 255, 164]],
    jet: [[0, 0, 0, 131], [0.125, 0, 60, 170], [0.375, 5, 255, 255], [0.625, 255, 255, 0], [0.875, 250, 0, 0], [1, 128, 0, 0]],
    grayscale: [[0, 0, 0, 0], [1, 255, 255, 255]],
  };

  // Build a 256-entry RGB lookup table from control points.
  function buildLut(name) {
    const pts = COLORMAPS[name] || COLORMAPS.viridis;
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let a = pts[0], b = pts[pts.length - 1];
      for (let k = 0; k < pts.length - 1; k++) {
        if (t >= pts[k][0] && t <= pts[k + 1][0]) { a = pts[k]; b = pts[k + 1]; break; }
      }
      const span = (b[0] - a[0]) || 1;
      const f = (t - a[0]) / span;
      lut[i * 3] = a[1] + (b[1] - a[1]) * f;
      lut[i * 3 + 1] = a[2] + (b[2] - a[2]) * f;
      lut[i * 3 + 2] = a[3] + (b[3] - a[3]) * f;
    }
    return lut;
  }

  // ---- Canvas sizing (devicePixelRatio aware) ----
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      // Preserve existing content on resize by copying old image.
      const old = canvas.width && canvas.height
        ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
      canvas.width = w;
      canvas.height = h;
      // Resizing resets context state; keep scroll blits pixel-exact.
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      if (old) ctx.putImageData(old, 0, 0);
    }
    const arect = axisCanvas.getBoundingClientRect();
    axisCanvas.width = Math.max(1, Math.round(arect.width * dpr));
    axisCanvas.height = Math.max(1, Math.round(arect.height * dpr));
    drawAxis();
  }

  // ---- Frequency range (clamped to Nyquist; log needs fmin >= 1 Hz) ----
  function freqRange(nyquist) {
    let fmax = Math.min(state.fmax, nyquist);
    let fmin = Math.max(state.fmin, 0);
    if (state.log) fmin = Math.max(fmin, 1);
    if (fmin >= fmax) fmin = Math.max(state.log ? 1 : 0, fmax - 1);
    return { fmin, fmax };
  }

  // ---- Frequency axis labels ----
  function niceTicks(fmin, fmax) {
    const candidates = [10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000,
      5000, 10000, 15000, 20000, 30000, 50000];
    return candidates.filter((f) => f >= fmin && f <= fmax);
  }

  function drawAxis() {
    const w = axisCanvas.width, h = axisCanvas.height;
    const dpr = window.devicePixelRatio || 1;
    axisCtx.clearRect(0, 0, w, h);
    axisCtx.fillStyle = '#161a22';
    axisCtx.fillRect(0, 0, w, h);
    // Radius (not the vertical axis) encodes frequency in galaxy mode, so
    // the tick labels would be meaningless — leave the panel blank.
    if (state.mode === 'galaxy') return;
    if (!state.audioCtx) return;
    const nyquist = state.audioCtx.sampleRate / 2;
    const { fmin, fmax } = freqRange(nyquist);
    axisCtx.fillStyle = '#9aa3b2';
    axisCtx.strokeStyle = '#2a3140';
    axisCtx.font = `${11 * dpr}px system-ui, sans-serif`;
    axisCtx.textAlign = 'right';
    axisCtx.textBaseline = 'middle';

    const label = (freq) => {
      if (freq >= 1000) return (Math.round(freq / 100) / 10) + 'k';
      return String(Math.round(freq));
    };
    const yFor = (freq) => {
      if (state.log) {
        const lf = Math.log(freq / fmin) / Math.log(fmax / fmin);
        return h - lf * h;
      }
      return h - ((freq - fmin) / (fmax - fmin)) * h;
    };

    let ticks;
    if (state.log) {
      ticks = niceTicks(fmin, fmax);
    } else {
      ticks = [];
      const step = (fmax - fmin) / 10;
      for (let i = 0; i <= 10; i++) ticks.push(Math.round(fmin + i * step));
    }
    for (const f of ticks) {
      const y = yFor(f);
      if (y < 6 || y > h - 2) continue;
      axisCtx.beginPath();
      axisCtx.moveTo(w - 5 * dpr, y);
      axisCtx.lineTo(w, y);
      axisCtx.stroke();
      axisCtx.fillText(label(f), w - 7 * dpr, y);
    }
  }

  // ---- Render loop ----
  // Scrolling is time-based: `speed` means CSS px per 1/60 s, so the image
  // moves at the same rate (and smears the same amount) on 60 Hz and 120 Hz
  // displays instead of scrolling twice as fast on ProMotion screens.
  function draw(now) {
    state.rafId = requestAnimationFrame(draw);
    if (!state.running || state.paused) { state.lastT = 0; return; }
    if (!state.lastT) { state.lastT = now; state.acc = 0; return; }

    // Clamp dt so a background-tab gap doesn't paint one huge stale column
    // (or one giant art-mode fade/zoom step).
    const dt = Math.min((now - state.lastT) / 1000, 0.25);
    state.lastT = now;
    if (state.mode === 'galaxy') { drawArt(dt, now); return; }

    const w = canvas.width, h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    state.acc += dt * state.speed * 60 * dpr;
    let cols = state.acc | 0;
    if (!cols) return;
    state.acc -= cols;
    if (cols > w) { cols = w; state.acc = 0; }

    state.analyser.getFloatFrequencyData(state.freqData);

    const binCount = state.analyser.frequencyBinCount;
    const nyquist = state.audioCtx.sampleRate / 2;
    const range = (state.ceil - state.floor) || 1;
    const lut = state.lut;

    // Scroll existing content left by `cols` device pixels.
    if (cols < w) ctx.drawImage(canvas, cols, 0, w - cols, h, 0, 0, w - cols, h);

    // Build the newest column (height h), then stamp it `cols` px wide.
    const col = ctx.createImageData(cols, h);
    const data = col.data;
    const { fmin, fmax } = freqRange(nyquist);
    const logDen = Math.log(fmax / fmin);
    const linSpan = fmax - fmin;
    const maxBin = binCount - 1;

    // FFT bin index at every pixel-row boundary; row y covers
    // edges[y] (top, higher frequency) down to edges[y+1].
    const edges = new Float32Array(h + 1);
    for (let y = 0; y <= h; y++) {
      // y=0 is top → highest displayed frequency.
      const frac = 1 - (y - 0.5) / (h - 1 || 1);
      const freq = state.log ? fmin * Math.exp(frac * logDen) : fmin + frac * linSpan;
      let binF = (freq / nyquist) * maxBin;
      if (binF < 0) binF = 0; else if (binF > maxBin) binF = maxBin;
      edges[y] = binF;
    }

    for (let y = 0; y < h; y++) {
      const hiBin = edges[y], loBin = edges[y + 1];
      const b0 = Math.ceil(loBin), b1 = Math.floor(hiBin);
      let db;
      if (b1 - b0 >= 1) {
        // Several bins land on this row: keep the strongest so narrow peaks
        // stay sharp instead of being sampled away (max-pooling).
        db = -Infinity;
        for (let b = b0; b <= b1; b++) if (state.freqData[b] > db) db = state.freqData[b];
      } else {
        // Row sits between bins: interpolate the two neighbours so sparse
        // low-frequency bins render as smooth gradients instead of blocky bands.
        const c = (loBin + hiBin) / 2;
        const lo = c | 0;
        const hi = lo < maxBin ? lo + 1 : lo;
        const t = c - lo;
        db = state.freqData[lo] * (1 - t) + state.freqData[hi] * t;
      }
      let n = (db - state.floor) / range;
      if (n < 0) n = 0; else if (n > 1) n = 1;
      // Contrast curve: pushes weak noise toward black while keeping strong
      // signal bright, giving a crisper image (gamma=1 is the linear mapping).
      n = Math.pow(n, state.gamma);
      const li = (n * 255) | 0;
      const r = lut[li * 3], g = lut[li * 3 + 1], b = lut[li * 3 + 2];

      for (let x = 0; x < cols; x++) {
        const p = (y * cols + x) * 4;
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      }
    }
    ctx.putImageData(col, w - cols, 0);
  }

  // ---- Art mode: radial galaxy ----
  // The live spectrum is painted once per frame into a thin radial "strip"
  // (row 0 = rim = fmax, last row = core = fmin), then stamped around the
  // circle as glowing additive spokes. Each frame the previous image is
  // re-drawn slightly zoomed outward, rotated and dimmed, so history spirals
  // away from the center like a nebula.

  function blackFill(c2d, cv) {
    c2d.setTransform(1, 0, 0, 1, 0, 0);
    c2d.globalAlpha = 1;
    c2d.globalCompositeOperation = 'source-over';
    c2d.fillStyle = '#000';
    c2d.fillRect(0, 0, cv.width, cv.height);
  }

  function ensureArtCanvases(w, h) {
    if (art.front && art.front.cv.width === w && art.front.cv.height === h) return;
    const make = () => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const c2d = cv.getContext('2d', { alpha: false });
      c2d.imageSmoothingEnabled = true; // the feedback zoom must interpolate
      c2d.fillStyle = '#000';
      c2d.fillRect(0, 0, w, h);
      return { cv, c2d };
    };
    const old = art.front;
    art.front = make();
    art.back = make();
    // Keep the nebula across resizes (stretch is fine — it's abstract art).
    if (old) art.front.c2d.drawImage(old.cv, 0, 0, w, h);
  }

  function resetArtTrails() {
    if (art.front) blackFill(art.front.c2d, art.front.cv);
    if (art.back) blackFill(art.back.c2d, art.back.cv);
    art.energy = 0;
    art.bass = 0;
  }

  // Average normalized loudness (0..1) over a frequency band.
  function bandEnergy(loHz, hiHz, nyquist, maxBin) {
    const hzPerBin = nyquist / maxBin;
    const b0 = Math.max(1, Math.floor(loHz / hzPerBin));
    const b1 = Math.min(maxBin, Math.ceil(hiHz / hzPerBin));
    if (b1 < b0) return 0;
    const range = (state.ceil - state.floor) || 1;
    let sum = 0;
    for (let b = b0; b <= b1; b++) {
      const n = (state.freqData[b] - state.floor) / range;
      sum += n < 0 ? 0 : n > 1 ? 1 : n;
    }
    return sum / (b1 - b0 + 1);
  }

  // Build the spoke texture. Same bin mapping as the classic column loop
  // (max-pooling when several bins land on a row, interpolation between
  // sparse bins), but with per-pixel alpha so quiet frequencies stay
  // transparent — additive spoke stamping then never builds up gray haze.
  function buildStrip(R, fmin, fmax, nyquist) {
    const dpr = window.devicePixelRatio || 1;
    const SW = Math.max(2, Math.round(2 * dpr));
    if (!art.strip || art.strip.width !== SW || art.strip.height !== R) {
      art.strip = document.createElement('canvas');
      art.strip.width = SW;
      art.strip.height = R;
      art.stripCtx = art.strip.getContext('2d');
    }
    const img = art.stripCtx.createImageData(SW, R);
    const data = img.data;
    const maxBin = state.analyser.frequencyBinCount - 1;
    const range = (state.ceil - state.floor) || 1;
    const lut = state.lut;
    const logDen = Math.log(fmax / fmin);
    const linSpan = fmax - fmin;

    const edges = new Float32Array(R + 1);
    for (let y = 0; y <= R; y++) {
      const frac = 1 - (y - 0.5) / (R - 1 || 1); // row 0 = rim = fmax
      const freq = state.log ? fmin * Math.exp(frac * logDen) : fmin + frac * linSpan;
      let binF = (freq / nyquist) * maxBin;
      if (binF < 0) binF = 0; else if (binF > maxBin) binF = maxBin;
      edges[y] = binF;
    }
    for (let y = 0; y < R; y++) {
      const hiBin = edges[y], loBin = edges[y + 1];
      const b0 = Math.ceil(loBin), b1 = Math.floor(hiBin);
      let db;
      if (b1 - b0 >= 1) {
        db = -Infinity;
        for (let b = b0; b <= b1; b++) if (state.freqData[b] > db) db = state.freqData[b];
      } else {
        const c = (loBin + hiBin) / 2;
        const lo = c | 0;
        const hi = lo < maxBin ? lo + 1 : lo;
        const t = c - lo;
        db = state.freqData[lo] * (1 - t) + state.freqData[hi] * t;
      }
      let n = (db - state.floor) / range;
      if (n < 0) n = 0; else if (n > 1) n = 1;
      n = Math.pow(n, state.gamma);
      const li = (n * 255) | 0;
      const r = lut[li * 3], g = lut[li * 3 + 1], b = lut[li * 3 + 2];
      for (let x = 0; x < SW; x++) {
        const p = (y * SW + x) * 4;
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = li;
      }
    }
    art.stripCtx.putImageData(img, 0, 0);
  }

  function drawArt(dt, now) {
    const w = canvas.width, h = canvas.height;
    ensureArtCanvases(w, h);
    state.analyser.getFloatFrequencyData(state.freqData);

    const nyquist = state.audioCtx.sampleRate / 2;
    const { fmin, fmax } = freqRange(nyquist);
    const maxBin = state.analyser.frequencyBinCount - 1;

    // Loudness detectors: fast attack, slow release, frame-rate independent.
    const loud = bandEnergy(fmin, fmax, nyquist, maxBin);
    const bassE = bandEnergy(fmin, Math.min(250, fmax), nyquist, maxBin);
    const follow = (cur, target, up, down) =>
      cur + (target - cur) * (1 - Math.pow(target > cur ? up : down, dt * 60));
    art.energy = follow(art.energy, loud, 0.55, 0.93);
    art.bass = follow(art.bass, bassE, 0.45, 0.90);

    const cx = w / 2, cy = h / 2;
    const rMax = 0.5 * Math.min(w, h);
    const rCore = 0.06 * Math.min(w, h);
    buildStrip(Math.max(2, Math.round(rMax - rCore)), fmin, fmax, nyquist);

    // Dynamics: Speed sets the base pace, loudness adds drama. Everything is
    // raised to dt so 60 Hz and 120 Hz displays drift and fade at one rate.
    const trail = Math.pow(0.08, dt); // 8% of the image survives one second
    const zoom = Math.pow(1.03 + 0.02 * state.speed + 0.30 * art.energy, dt);
    const omega = 0.03 * state.speed + 0.9 * art.energy; // rad/s
    art.angle -= 0.25 * omega * dt; // spokes counter-rotate slightly (parallax)

    const src = art.front, dst = art.back;
    const c = dst.c2d;

    // 1) Previous frame zoomed outward + rotated + dimmed: the spiral trail.
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    c.globalAlpha = trail;
    c.setTransform(1, 0, 0, 1, cx, cy);
    c.rotate(omega * dt);
    c.scale(zoom, zoom);
    c.drawImage(src.cv, -cx, -cy);
    c.setTransform(1, 0, 0, 1, cx, cy);
    c.globalAlpha = 1;

    // 2) Live spectrum stamped as glowing spokes (additive).
    c.globalCompositeOperation = 'lighter';
    const N = 120;
    const sw = art.strip.width;
    const t = now * 0.001;
    for (let i = 0; i < N; i++) {
      c.save();
      c.rotate(art.angle + (i / N) * Math.PI * 2);
      // Deterministic per-spoke flicker for organic shimmer.
      c.globalAlpha = 0.35 + 0.3 * Math.sin(i * 2.39996 + t * (1 + (i % 5)));
      c.drawImage(art.strip, -sw / 2, -rMax);
      c.restore();
    }

    // 3) Bass pulse at the core, tinted from the bright end of the active LUT.
    const li = 230;
    const col = `rgba(${state.lut[li * 3]},${state.lut[li * 3 + 1]},${state.lut[li * 3 + 2]},`;
    const br = rCore * (1.0 + 2.5 * art.bass);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, br);
    g.addColorStop(0, col + (0.85 * art.bass).toFixed(3) + ')');
    g.addColorStop(1, col + '0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, br, 0, Math.PI * 2);
    c.fill();

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';

    // 4) Present and swap the ping-pong pair.
    ctx.drawImage(dst.cv, 0, 0);
    art.front = dst;
    art.back = src;
  }

  // ---- Audio ----
  async function start() {
    try {
      setStatus('Requesting microphone…');
      const deviceId = deviceSelect.value || undefined;
      const constraints = {
        audio: deviceId
          ? { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.stream = stream;

      ensureAudioCtx();
      if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();

      state.analyser = state.audioCtx.createAnalyser();
      applyFft();
      state.analyser.smoothingTimeConstant = parseFloat(smoothRange.value);

      state.source = state.audioCtx.createMediaStreamSource(stream);
      state.source.connect(state.analyser);
      // Note: analyser is NOT connected to destination → no feedback/echo.

      state.running = true;
      state.paused = false;
      overlay.classList.add('hidden');
      renderPlay();
      deviceSelect.disabled = false;
      // Collapse the panel so the user immediately sees the full spectrogram.
      toggleControls(false);

      const nyquist = Math.round(state.audioCtx.sampleRate / 2);
      maxFreqInput.max = nyquist;
      minFreqInput.max = nyquist;

      await populateDevices();
      resizeCanvas();
      drawAxis();
      setStatus(`Listening — ${Math.round(state.audioCtx.sampleRate / 1000)} kHz, FFT ${state.analyser.fftSize}.`);

      if (!state.rafId) state.rafId = requestAnimationFrame(draw);
    } catch (err) {
      handleError(err);
    }
  }

  function stop() {
    state.running = false;
    state.paused = false;
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; }
    state.lastT = 0;
    if (state.source) { try { state.source.disconnect(); } catch (_) {} state.source = null; }
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    renderPlay();
    setStatus('Stopped.');
  }

  // Reflect audio state on the floating play/pause button: ⏸ while live,
  // ▶ when idle or paused; red whenever the mic is running.
  function renderPlay() {
    const active = state.running && !state.paused;
    playBtn.textContent = active ? '⏸' : '▶';
    const label = !state.running ? 'Start' : state.paused ? 'Resume' : 'Pause';
    playBtn.setAttribute('aria-label', label);
    playBtn.title = label;
    playBtn.classList.toggle('recording', state.running);
  }

  function applyFft() {
    if (!state.analyser) return;
    state.analyser.fftSize = parseInt(fftSelect.value, 10);
    state.freqData = new Float32Array(state.analyser.frequencyBinCount);
  }

  async function populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      const current = deviceSelect.value;
      deviceSelect.innerHTML = '';
      mics.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${i + 1}`;
        deviceSelect.appendChild(opt);
      });
      if (current) deviceSelect.value = current;
    } catch (_) { /* ignore */ }
  }

  // ---- Controls ----
  // Lazily create the shared AudioContext. iOS Safari only unlocks it from
  // inside a user gesture, so we call this synchronously on the Start click
  // (before any await) — once unlocked it stays usable for later starts.
  function ensureAudioCtx() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AC();
    }
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    return state.audioCtx;
  }

  // One button drives start + pause/resume; the mic stays live while paused.
  playBtn.addEventListener('click', () => {
    if (!state.running) {
      try { ensureAudioCtx(); } catch (_) { /* start() surfaces real failures */ }
      start();
      return;
    }
    state.paused = !state.paused;
    setStatus(state.paused ? 'Paused (mic still live).' : 'Listening…');
    renderPlay();
  });

  function clearCanvas() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    resetArtTrails();
  }

  clearBtn.addEventListener('click', clearCanvas);

  // Show/hide the controls drawer. The drawer is an overlay so the stage size
  // doesn't change, but resizeCanvas() keeps the axis crisp across DPR changes.
  function toggleControls(open) {
    const next = open === undefined ? !document.body.classList.contains('controls-open') : open;
    document.body.classList.toggle('controls-open', next);
    menuBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    resizeCanvas();
  }
  menuBtn.addEventListener('click', () => toggleControls());
  closeBtn.addEventListener('click', () => toggleControls(false));

  // ---- Immersive view (hide chrome for an always-on display) ----
  // Axis + status leave the layout once per toggle; the FABs are fixed, so
  // their idle fade (ui-hidden) never re-layouts the stage.
  let uiIdleTimer = 0;
  function pokeUi() {
    if (!document.body.classList.contains('immersive')) return;
    document.body.classList.remove('ui-hidden');
    clearTimeout(uiIdleTimer);
    uiIdleTimer = setTimeout(() => document.body.classList.add('ui-hidden'), 3000);
  }
  function setImmersive(on) {
    document.body.classList.toggle('immersive', on);
    if (on) pokeUi();
    else { document.body.classList.remove('ui-hidden'); clearTimeout(uiIdleTimer); }
    // Axis + status entered/left the layout; resize the canvas right away.
    resizeCanvas();
  }
  immersiveBtn.addEventListener('click', () =>
    setImmersive(!document.body.classList.contains('immersive')));
  window.addEventListener('pointermove', pokeUi);
  window.addEventListener('pointerdown', pokeUi);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('immersive')) setImmersive(false);
  });

  deviceSelect.addEventListener('change', () => {
    if (state.running) { stop(); start(); }
  });

  fftSelect.addEventListener('change', () => {
    applyFft();
    if (state.running) setStatus(`FFT ${state.analyser.fftSize}.`);
  });

  colorSelect.addEventListener('change', () => {
    state.colormap = colorSelect.value;
    state.lut = buildLut(state.colormap);
  });

  logToggle.addEventListener('change', () => {
    state.log = logToggle.checked;
    drawAxis();
  });

  modeSelect.addEventListener('change', () => {
    state.mode = modeSelect.value;
    clearCanvas();
    state.acc = 0; // classic scroll accumulator: no burst when switching back
    drawAxis();
  });

  function applyFreqRange() {
    let lo = parseFloat(minFreqInput.value);
    let hi = parseFloat(maxFreqInput.value);
    if (!isFinite(lo)) lo = 0;
    if (!isFinite(hi)) hi = 20000;
    if (hi <= lo) hi = lo + 10;
    state.fmin = lo;
    state.fmax = hi;
    drawAxis();
  }
  minFreqInput.addEventListener('change', applyFreqRange);
  maxFreqInput.addEventListener('change', applyFreqRange);

  floorRange.addEventListener('input', () => {
    state.floor = parseFloat(floorRange.value);
    floorVal.textContent = state.floor;
  });
  ceilRange.addEventListener('input', () => {
    state.ceil = parseFloat(ceilRange.value);
    ceilVal.textContent = state.ceil;
  });
  smoothRange.addEventListener('input', () => {
    const v = parseFloat(smoothRange.value);
    smoothVal.textContent = v.toFixed(2);
    if (state.analyser) state.analyser.smoothingTimeConstant = v;
  });
  contrastRange.addEventListener('input', () => {
    state.gamma = parseFloat(contrastRange.value);
    contrastVal.textContent = state.gamma.toFixed(1);
  });
  speedRange.addEventListener('input', () => {
    state.speed = parseInt(speedRange.value, 10);
    speedVal.textContent = state.speed;
  });

  window.addEventListener('resize', resizeCanvas);
  // Catch stage size changes that don't fire a window resize (status text
  // wrapping, iOS dynamic chrome with dvh) — a stale backing store means the
  // browser CSS-stretches the canvas, blurring everything.
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(canvas);

  // ---- Helpers ----
  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
  }

  function handleError(err) {
    console.error(err);
    let msg = err && err.message ? err.message : String(err);
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      msg = 'Microphone access was denied. Allow it in your browser, then tap ▶ again.';
    } else if (err && err.name === 'NotFoundError') {
      msg = 'No microphone found. Connect an input device and try again.';
    }
    setStatus(msg, true);
    stop();
  }

  // ---- Init ----
  // The DOM controls ship without value attributes, so push every DEFAULT into
  // both the inputs and `state` on load. (This also overrides any values a
  // browser tries to restore across a refresh.)
  function initControls() {
    fftSelect.value = DEFAULTS.fft;
    colorSelect.value = DEFAULTS.color;
    logToggle.checked = DEFAULTS.log;
    modeSelect.value = DEFAULTS.mode;
    minFreqInput.value = DEFAULTS.fmin;
    maxFreqInput.value = DEFAULTS.fmax;
    floorRange.value = DEFAULTS.floor;
    ceilRange.value = DEFAULTS.ceil;
    smoothRange.value = DEFAULTS.smooth;
    contrastRange.value = DEFAULTS.gamma;
    speedRange.value = DEFAULTS.speed;

    state.log = DEFAULTS.log;
    state.mode = DEFAULTS.mode;
    state.colormap = DEFAULTS.color;
    state.floor = DEFAULTS.floor;
    state.ceil = DEFAULTS.ceil;
    state.speed = DEFAULTS.speed;
    state.gamma = DEFAULTS.gamma;
    state.fmin = DEFAULTS.fmin;
    state.fmax = DEFAULTS.fmax;

    floorVal.textContent = DEFAULTS.floor;
    ceilVal.textContent = DEFAULTS.ceil;
    smoothVal.textContent = DEFAULTS.smooth.toFixed(2);
    contrastVal.textContent = DEFAULTS.gamma.toFixed(1);
    speedVal.textContent = DEFAULTS.speed;
  }

  initControls();
  renderPlay();

  // Controls start hidden everywhere — only the floating buttons show.

  state.lut = buildLut(state.colormap);
  resizeCanvas();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser does not support microphone capture (getUserMedia).', true);
    playBtn.disabled = true;
  } else {
    setStatus('Ready. Tap ▶ to begin.');
  }
})();
