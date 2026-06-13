/* Spectri — live microphone spectrogram.
 * Vanilla Web Audio API + Canvas 2D. No dependencies, no build step. */
(() => {
  'use strict';

  // ---- Defaults (single source of truth) ----
  // Every default value lives here. The DOM controls carry no `value`/`selected`
  // attributes — `initControls()` writes these into both the inputs and `state`
  // on load, so changing a default only ever needs an edit in this object.
  const DEFAULTS = {
    fft: '4096', color: 'jet', log: true,
    floor: -95, ceil: -60, smooth: 0.05, speed: 2, gamma: 0.6,
    fmin: 20, fmax: 15000, mode: 'rainbow',
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const playBtn = $('playBtn');
  const recordBtn = $('recordBtn');
  const clearBtn = $('clearBtn');
  const menuBtn = $('menuBtn');
  const closeBtn = $('closeBtn');
  const deviceSelect = $('deviceSelect');
  const fftSelect = $('fftSelect');
  const colorSelect = $('colorSelect');
  const colorGroup = $('colorGroup');
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
  const selCanvas = $('selCanvas');
  const axisCanvas = $('freqAxis');
  const overlay = $('overlay');
  const statusEl = $('status');
  const playbackBar = $('playbackBar');
  const selectAllBtn = $('selectAllBtn');
  const playBandBtn = $('playBandBtn');
  const loopChk = $('loopChk');
  const saveBandBtn = $('saveBandBtn');
  const selInfo = $('selInfo');
  const backLiveBtn = $('backLiveBtn');

  const ctx = canvas.getContext('2d', { alpha: false });
  const selCtx = selCanvas.getContext('2d');
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

    // ---- Record & playback ----
    view: 'live',        // 'live' (scrolling mic) | 'playback' (static recording)
    recorder: null,      // MediaRecorder capturing the live stream
    recChunks: null,     // Array<Blob> collected while recording
    recActive: false,    // currently capturing
    recording: null,     // decoded AudioBuffer of the last take
    recDuration: 0,      // recording length (s)
    sel: null,           // {x0,x1,y0,y1 css px; t0,t1 s; fLo,fHi Hz}
    playSource: null,    // AudioBufferSourceNode currently sounding
    playRafId: 0,        // cursor-sweep animation handle
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

  // ---- Rainbow mode: hard frequency zones, each its own colour ----
  // [hiHz, r, g, b]; the last zone catches everything up to Nyquist, the
  // first everything below 150 Hz, so the visible range is always coloured.
  const RAINBOW_BANDS = [
    [150, 220, 50, 50],       // 100 Hz  red
    [350, 240, 130, 35],      // 200 Hz  orange
    [750, 235, 210, 45],      // 500 Hz  yellow
    [1500, 70, 200, 90],      // 1 kHz   green
    [3500, 40, 200, 200],     // 2 kHz   cyan
    [7500, 60, 110, 235],     // 5 kHz   blue
    [Infinity, 165, 80, 225], // 10 kHz  violet
  ];
  function buildBandLut(r, g, b) {
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      lut[i * 3] = r * t; lut[i * 3 + 1] = g * t; lut[i * 3 + 2] = b * t;
    }
    return lut;
  }
  const RAINBOW_LUTS = RAINBOW_BANDS.map((b) => buildBandLut(b[1], b[2], b[3]));
  function rainbowLutForFreq(freq) {
    for (let i = 0; i < RAINBOW_BANDS.length; i++) {
      if (freq < RAINBOW_BANDS[i][0]) return RAINBOW_LUTS[i];
    }
    return RAINBOW_LUTS[RAINBOW_LUTS.length - 1];
  }

  // ---- Canvas sizing (devicePixelRatio aware) ----
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    const sized = canvas.width !== w || canvas.height !== h;
    if (sized) {
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
    // Keep the selection overlay matched to the spectrogram backing store.
    if (selCanvas.width !== w || selCanvas.height !== h) {
      selCanvas.width = w; selCanvas.height = h;
    }
    const arect = axisCanvas.getBoundingClientRect();
    axisCanvas.width = Math.max(1, Math.round(arect.width * dpr));
    axisCanvas.height = Math.max(1, Math.round(arect.height * dpr));
    drawAxis();
    // A resized backing store means the static recording must be repainted.
    if (sized && state.view === 'playback') renderStaticSpectrogram();
  }

  // ---- Frequency range (clamped to Nyquist; log needs fmin >= 1 Hz) ----
  function freqRange(nyquist) {
    let fmax = Math.min(state.fmax, nyquist);
    let fmin = Math.max(state.fmin, 0);
    if (state.log) fmin = Math.max(fmin, 1);
    if (fmin >= fmax) fmin = Math.max(state.log ? 1 : 0, fmax - 1);
    return { fmin, fmax };
  }

  // ---- EQ band mode: 10 standard octave bands (edges at center·2^±0.5) ----
  const EQ_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  // Centers that fall inside the displayed [fmin, fmax] range.
  function eqBands(nyquist) {
    const { fmin, fmax } = freqRange(nyquist);
    return EQ_CENTERS.filter((c) => c >= fmin && c <= fmax);
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

    if (state.mode === 'bands') {
      const centers = eqBands(nyquist);
      const nBands = centers.length;
      if (!nBands) return; // nothing displayed: blank panel
      for (let i = 0; i <= nBands; i++) { // tick at every stripe boundary
        const y = Math.min(Math.round((i * h) / nBands), h - 1) + 0.5;
        axisCtx.beginPath();
        axisCtx.moveTo(w - 5 * dpr, y);
        axisCtx.lineTo(w, y);
        axisCtx.stroke();
      }
      for (let k = 0; k < nBands; k++) { // center label per stripe
        const slot = nBands - 1 - k;
        const y = Math.round(((slot + 0.5) * h) / nBands);
        const c = centers[k];
        // floor() keeps 31.5 printing as the conventional "31".
        axisCtx.fillText(label(c < 100 ? Math.floor(c) : c), w - 7 * dpr, y);
      }
      return;
    }

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
    if (state.view === 'playback') { state.lastT = 0; return; }
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

    if (state.mode === 'bands') {
      // EQ bands: one solid stripe per octave band. The black pre-fill is
      // both the separator gaps and the fallback when no band fits the range.
      const centers = eqBands(nyquist);
      const nBands = centers.length;
      const x = w - cols;
      ctx.fillStyle = '#000';
      ctx.fillRect(x, 0, cols, h);
      const maxBin = binCount - 1;
      const SEP = 2; // device px dark gap below each stripe boundary
      for (let k = 0; k < nBands; k++) { // k=0 = lowest band
        const cHz = centers[k];
        let b0 = Math.round((cHz / Math.SQRT2 / nyquist) * maxBin);
        let b1 = Math.round((Math.min(cHz * Math.SQRT2, nyquist) / nyquist) * maxBin);
        if (b0 < 0) b0 = 0;
        if (b1 > maxBin) b1 = maxBin;
        if (b1 < b0) b1 = b0; // band narrower than one bin: nearest-bin read
        // Max-pool the band's bins so narrow peaks keep the stripe lit.
        let db = -Infinity;
        for (let b = b0; b <= b1; b++) if (state.freqData[b] > db) db = state.freqData[b];
        let n = (db - state.floor) / range;
        if (n < 0) n = 0; else if (n > 1) n = 1;
        n = Math.pow(n, state.gamma);
        const li = (n * 255) | 0;
        ctx.fillStyle = `rgb(${lut[li * 3]},${lut[li * 3 + 1]},${lut[li * 3 + 2]})`;
        const slot = nBands - 1 - k; // bottom = lowest frequency
        const yTop = Math.round((slot * h) / nBands);
        const yBot = Math.round(((slot + 1) * h) / nBands);
        ctx.fillRect(x, yTop + SEP, cols, yBot - yTop - SEP);
      }
      return;
    }

    // Build the newest column (height h), then stamp it `cols` px wide.
    const col = ctx.createImageData(cols, h);
    const layout = computeRowLayout(h, nyquist, binCount);
    paintColumn(col.data, cols, 0, cols, h, state.freqData, layout);
    ctx.putImageData(col, w - cols, 0);
  }

  // ---- Shared column painting (live scroll + static recording render) ----
  // Precompute, for the current freq range / log toggle, the FFT-bin index at
  // every pixel-row boundary and (in rainbow mode) the per-row palette. Both
  // the live draw loop and the static spectrogram renderer reuse this so their
  // frequency→pixel mapping is guaranteed identical.
  function computeRowLayout(h, nyquist, binCount) {
    const { fmin, fmax } = freqRange(nyquist);
    const logDen = Math.log(fmax / fmin);
    const linSpan = fmax - fmin;
    const maxBin = binCount - 1;
    // row y covers edges[y] (top, higher frequency) down to edges[y+1].
    const edges = new Float32Array(h + 1);
    for (let y = 0; y <= h; y++) {
      const frac = 1 - (y - 0.5) / (h - 1 || 1); // y=0 is top → highest freq
      const freq = state.log ? fmin * Math.exp(frac * logDen) : fmin + frac * linSpan;
      let binF = (freq / nyquist) * maxBin;
      if (binF < 0) binF = 0; else if (binF > maxBin) binF = maxBin;
      edges[y] = binF;
    }
    // Rainbow mode tints each row by its true frequency, tracking Log + range.
    let rowLut = null;
    if (state.mode === 'rainbow') {
      rowLut = new Array(h);
      for (let y = 0; y < h; y++) {
        const frac = 1 - y / (h - 1 || 1);
        const freq = state.log ? fmin * Math.exp(frac * logDen) : fmin + frac * linSpan;
        rowLut[y] = rainbowLutForFreq(freq);
      }
    }
    return { edges, rowLut, maxBin };
  }

  // Paint columns [x, x+cols) of an ImageData buffer (row stride `stride` px)
  // from a per-bin dB array, applying floor/ceil, contrast and the colormap.
  function paintColumn(data, stride, x, cols, h, dbArr, layout) {
    const { edges, rowLut, maxBin } = layout;
    const range = (state.ceil - state.floor) || 1;
    const lut = state.lut;
    for (let y = 0; y < h; y++) {
      const hiBin = edges[y], loBin = edges[y + 1];
      const b0 = Math.ceil(loBin), b1 = Math.floor(hiBin);
      let db;
      if (b1 - b0 >= 1) {
        // Several bins land on this row: keep the strongest so narrow peaks
        // stay sharp instead of being sampled away (max-pooling).
        db = -Infinity;
        for (let b = b0; b <= b1; b++) if (dbArr[b] > db) db = dbArr[b];
      } else {
        // Row sits between bins: interpolate the two neighbours so sparse
        // low-frequency bins render as smooth gradients instead of blocky bands.
        const c = (loBin + hiBin) / 2;
        const lo = c | 0;
        const hi = lo < maxBin ? lo + 1 : lo;
        const t = c - lo;
        db = dbArr[lo] * (1 - t) + dbArr[hi] * t;
      }
      let n = (db - state.floor) / range;
      if (n < 0) n = 0; else if (n > 1) n = 1;
      // Contrast curve: pushes weak noise toward black while keeping strong
      // signal bright, giving a crisper image (gamma=1 is the linear mapping).
      n = Math.pow(n, state.gamma);
      const li = (n * 255) | 0;
      const rl = rowLut ? rowLut[y] : lut;
      const r = rl[li * 3], g = rl[li * 3 + 1], b = rl[li * 3 + 2];
      for (let xi = 0; xi < cols; xi++) {
        const p = (y * stride + x + xi) * 4;
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      }
    }
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

  // ============================================================
  //  Record → replay → isolate a frequency band
  // ============================================================

  // ---- Minimal FFT (radix-2, in-place) ----
  // The live path uses an AnalyserNode, but that can't batch-process a finished
  // recording, so we bring our own transform. Iterative Cooley–Tukey on
  // separate real/imag arrays; `n` must be a power of two (it always is — it's
  // the chosen FFT size). No dependencies, in keeping with the project.
  function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { // bit-reversal permutation
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + half], bi = im[i + k + half];
          const tr = br * cr - bi * ci, ti = br * ci + bi * cr;
          re[i + k] = ar + tr; im[i + k] = ai + ti;
          re[i + k + half] = ar - tr; im[i + k + half] = ai - ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // Hann window (suppresses spectral leakage), cached by size.
  let hannCache = null;
  function hannWindow(n) {
    if (hannCache && hannCache.length === n) return hannCache;
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache = w;
    return w;
  }

  // Mix an AudioBuffer down to one mono Float32Array.
  function mixMono(buf) {
    const ch = buf.numberOfChannels;
    if (ch === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < buf.length; i++) out[i] += d[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= ch;
    return out;
  }

  // ---- Static spectrogram of the whole recording ----
  // One STFT column per canvas x-pixel, painted with the same row mapping and
  // colormap as the live view (computeRowLayout / paintColumn). Galaxy/EQ modes
  // fall back to a classic render here — a 2D box only makes sense on a normal
  // time×frequency image.
  function renderStaticSpectrogram() {
    if (state.view !== 'playback' || !state.recording || !state.audioCtx) return;
    const W = canvas.width, h = canvas.height;
    const N = parseInt(fftSelect.value, 10);
    const binCount = N >> 1;
    const nyquist = state.audioCtx.sampleRate / 2;
    const mono = mixMono(state.recording);
    const total = mono.length;
    const win = hannWindow(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const dbArr = new Float32Array(binCount);
    const layout = computeRowLayout(h, nyquist, binCount);
    const img = ctx.createImageData(W, h);
    for (let x = 0; x < W; x++) {
      // Center the analysis window on the time this x-pixel represents.
      const center = Math.round((x / (W - 1 || 1)) * (total - 1));
      const off = center - (N >> 1);
      for (let i = 0; i < N; i++) {
        const idx = off + i;
        re[i] = (idx >= 0 && idx < total) ? mono[idx] * win[i] : 0;
        im[i] = 0;
      }
      fftRadix2(re, im);
      for (let k = 0; k < binCount; k++) {
        const mag = Math.hypot(re[k], im[k]) / N;
        dbArr[k] = 20 * Math.log10(mag < 1e-9 ? 1e-9 : mag);
      }
      paintColumn(img.data, W, x, 1, h, dbArr, layout);
    }
    ctx.putImageData(img, 0, 0);
    drawSelOverlay(); // keep any existing box visible over the fresh render
  }

  // ---- Recording (captures the live mic stream) ----
  function startRecording() {
    if (state.recActive || !state.stream) return;
    state.recChunks = [];
    let rec;
    try {
      rec = new MediaRecorder(state.stream); // let the browser pick the mime
    } catch (err) { handleError(err); return; }
    state.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
    rec.onstop = async () => {
      try {
        const blob = new Blob(state.recChunks);
        const arr = await blob.arrayBuffer();
        ensureAudioCtx();
        state.recording = await state.audioCtx.decodeAudioData(arr);
        state.recDuration = state.recording.duration;
        enterPlayback();
      } catch (err) { handleError(err); }
    };
    rec.start();
    state.recActive = true;
    renderRecord();
    setStatus('Recording… tap ● again to stop and replay.');
  }

  function stopRecording() {
    if (!state.recActive) return;
    state.recActive = false;
    try { state.recorder.stop(); } catch (_) {}
    renderRecord();
    setStatus('Processing recording…');
  }

  // ---- View switching ----
  function enterPlayback() {
    state.view = 'playback';
    document.body.classList.add('playback');
    playbackBar.hidden = false;
    state.sel = null;
    playBandBtn.disabled = true;
    saveBandBtn.disabled = true;
    selInfo.textContent = '';
    resizeCanvas();              // size selCanvas to match
    renderStaticSpectrogram();
    renderRecord();
    setStatus(`Recording ready (${state.recDuration.toFixed(1)} s). Drag a box to isolate a band.`);
  }

  function enterLive() {
    stopSelectionPlayback();
    state.view = 'live';
    document.body.classList.remove('playback');
    playbackBar.hidden = true;
    state.sel = null;
    clearSelOverlay();
    clearCanvas();              // wipe the static image; live scroll repaints
    state.lastT = 0;
    renderRecord();
    if (state.running) setStatus('Listening…');
    else setStatus('Ready. Tap ▶ to begin.');
  }

  // ---- Selection box (playback only) ----
  let dragging = false, dragX = 0, dragY = 0, curX = 0, curY = 0;

  // CSS-pixel y → frequency, mirroring the live row mapping exactly.
  function freqAtY(yCss, hCss) {
    const nyquist = state.audioCtx.sampleRate / 2;
    const { fmin, fmax } = freqRange(nyquist);
    const frac = 1 - yCss / (hCss - 1 || 1);
    return state.log ? fmin * Math.exp(frac * Math.log(fmax / fmin)) : fmin + frac * (fmax - fmin);
  }

  function onSelDown(e) {
    if (state.view !== 'playback') return;
    selCanvas.setPointerCapture(e.pointerId);
    const r = selCanvas.getBoundingClientRect();
    dragX = e.clientX - r.left; dragY = e.clientY - r.top;
    curX = dragX; curY = dragY;
    dragging = true;
  }
  function onSelMove(e) {
    if (!dragging) return;
    const r = selCanvas.getBoundingClientRect();
    curX = e.clientX - r.left; curY = e.clientY - r.top;
    drawSelOverlay();
  }
  function onSelUp(e) {
    if (!dragging) return;
    dragging = false;
    const r = selCanvas.getBoundingClientRect();
    const x0 = Math.max(0, Math.min(dragX, curX));
    const x1 = Math.min(r.width, Math.max(dragX, curX));
    const y0 = Math.max(0, Math.min(dragY, curY)); // top (higher freq)
    const y1 = Math.min(r.height, Math.max(dragY, curY));
    if (x1 - x0 < 4 || y1 - y0 < 4) {
      state.sel = null; drawSelOverlay();
      playBandBtn.disabled = true; saveBandBtn.disabled = true; selInfo.textContent = '';
      return;
    }
    const t0 = (x0 / r.width) * state.recDuration;
    const t1 = (x1 / r.width) * state.recDuration;
    const fHi = freqAtY(y0, r.height);
    const fLo = freqAtY(y1, r.height);
    state.sel = { x0, x1, y0, y1, t0, t1, fLo, fHi };
    playBandBtn.disabled = false;
    saveBandBtn.disabled = false;
    selInfo.textContent = `${Math.round(fLo)}–${Math.round(fHi)} Hz · ${t0.toFixed(2)}–${t1.toFixed(2)} s`;
    drawSelOverlay();
  }

  function clearSelOverlay() {
    selCtx.clearRect(0, 0, selCanvas.width, selCanvas.height);
  }
  // Redraw the box (committed or in-progress) plus an optional playback cursor.
  function drawSelOverlay(cursorXCss) {
    const dpr = window.devicePixelRatio || 1;
    clearSelOverlay();
    let box = state.sel;
    if (dragging) box = { x0: Math.min(dragX, curX), x1: Math.max(dragX, curX),
                          y0: Math.min(dragY, curY), y1: Math.max(dragY, curY) };
    if (box) {
      const x = box.x0 * dpr, y = box.y0 * dpr;
      const w = (box.x1 - box.x0) * dpr, h = (box.y1 - box.y0) * dpr;
      selCtx.fillStyle = 'rgba(78,161,255,0.12)';
      selCtx.fillRect(x, y, w, h);
      selCtx.strokeStyle = '#4ea1ff';
      selCtx.lineWidth = Math.max(1, dpr);
      selCtx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    if (cursorXCss != null) {
      selCtx.strokeStyle = '#ffffff';
      selCtx.lineWidth = Math.max(1, dpr);
      selCtx.beginPath();
      selCtx.moveTo(cursorXCss * dpr + 0.5, 0);
      selCtx.lineTo(cursorXCss * dpr + 0.5, selCanvas.height);
      selCtx.stroke();
    }
  }

  // ---- Hear the isolated band ----
  // A highpass at fLo + lowpass at fHi, each cascaded ×2 for a steeper, cleaner
  // passband than a single bandpass. Edges that reach the spectrum limits drop
  // the corresponding filter so they don't needlessly attenuate. Returns the
  // tail node so the caller can connect it to a destination; shared by live
  // playback and the offline WAV export.
  function buildBandChain(ac, src, fLo, fHi) {
    const nyquist = ac.sampleRate / 2;
    const chain = [];
    if (fLo > 25) { chain.push(['highpass', fLo]); chain.push(['highpass', fLo]); }
    if (fHi < nyquist * 0.98) { chain.push(['lowpass', fHi]); chain.push(['lowpass', fHi]); }
    let node = src;
    for (const [type, freq] of chain) {
      const f = ac.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = 0.707;
      node.connect(f); node = f;
    }
    return node;
  }

  function playSelection() {
    if (!state.sel || !state.recording) return;
    stopSelectionPlayback();
    ensureAudioCtx();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    const { t0, t1, fLo, fHi } = state.sel;
    const src = state.audioCtx.createBufferSource();
    src.buffer = state.recording;
    buildBandChain(state.audioCtx, src, fLo, fHi).connect(state.audioCtx.destination);

    const loop = loopChk.checked;
    const dur = Math.max(0.01, t1 - t0);
    if (loop) { src.loop = true; src.loopStart = t0; src.loopEnd = t1; src.start(0, t0); }
    else src.start(0, t0, dur);
    state.playSource = src;

    // Sweep a cursor across the selection in lockstep with audioCtx time.
    const startAt = state.audioCtx.currentTime;
    const x0 = state.sel.x0, x1 = state.sel.x1;
    const sweep = () => {
      const el = state.audioCtx.currentTime - startAt;
      if (!loop && el >= dur) { stopSelectionPlayback(); return; }
      const frac = dur > 0 ? (el % dur) / dur : 0;
      drawSelOverlay(x0 + (x1 - x0) * frac);
      state.playRafId = requestAnimationFrame(sweep);
    };
    src.onended = () => { if (!loop) stopSelectionPlayback(); };
    state.playRafId = requestAnimationFrame(sweep);
    renderRecord();
  }

  function stopSelectionPlayback() {
    if (state.playRafId) { cancelAnimationFrame(state.playRafId); state.playRafId = 0; }
    if (state.playSource) {
      try { state.playSource.onended = null; state.playSource.stop(); } catch (_) {}
      try { state.playSource.disconnect(); } catch (_) {}
      state.playSource = null;
    }
    drawSelOverlay(); // remove cursor, keep box
    renderRecord();
  }

  // ---- Select the whole recording (full time × full displayed range) ----
  function selectAll() {
    if (state.view !== 'playback' || !state.recording) return;
    const r = selCanvas.getBoundingClientRect();
    state.sel = {
      x0: 0, x1: r.width, y0: 0, y1: r.height,
      t0: 0, t1: state.recDuration,
      fHi: freqAtY(0, r.height), fLo: freqAtY(r.height, r.height),
    };
    playBandBtn.disabled = false;
    saveBandBtn.disabled = false;
    selInfo.textContent = `${Math.round(state.sel.fLo)}–${Math.round(state.sel.fHi)} Hz · ${state.sel.t0.toFixed(2)}–${state.sel.t1.toFixed(2)} s`;
    drawSelOverlay();
  }

  // ---- Export the selection to a WAV file ----
  // Re-render the chosen time slice through the same band filters offline (so
  // the file matches what you hear), then encode 16-bit PCM and download it.
  function renderSelectionBuffer(sel) {
    const buf = state.recording;
    const rate = buf.sampleRate;
    const dur = Math.max(0.01, sel.t1 - sel.t0);
    const frames = Math.max(1, Math.ceil(dur * rate));
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new OAC(buf.numberOfChannels, frames, rate);
    const src = offline.createBufferSource();
    src.buffer = buf;
    buildBandChain(offline, src, sel.fLo, sel.fHi).connect(offline.destination);
    src.start(0, sel.t0, dur);
    return offline.startRendering();
  }

  function audioBufferToWav(buf) {
    const numCh = buf.numberOfChannels, len = buf.length, rate = buf.sampleRate;
    const blockAlign = numCh * 2;            // 16-bit samples
    const dataLen = len * blockAlign;
    const view = new DataView(new ArrayBuffer(44 + dataLen));
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * blockAlign, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, dataLen, true);
    const chans = [];
    for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = chans[c][i];
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function saveSelection() {
    if (!state.sel || !state.recording) return;
    saveBandBtn.disabled = true;
    setStatus('Rendering WAV…');
    try {
      const out = await renderSelectionBuffer(state.sel);
      const { fLo, fHi } = state.sel;
      downloadBlob(audioBufferToWav(out), `spectri_${Math.round(fLo)}-${Math.round(fHi)}Hz.wav`);
      setStatus('Saved WAV.');
    } catch (err) {
      handleError(err);
    } finally {
      saveBandBtn.disabled = !state.sel;
    }
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

  // Reflect record/playback state on the ● button and the Play-band button.
  function renderRecord() {
    recordBtn.textContent = state.recActive ? '■' : '●';
    recordBtn.title = state.recActive ? 'Stop recording'
      : state.view === 'playback' ? 'Record a new take' : 'Record this session';
    recordBtn.setAttribute('aria-label', state.recActive ? 'Stop recording' : 'Record');
    recordBtn.classList.toggle('recording', state.recActive);
    const playing = !!state.playSource;
    playBandBtn.textContent = playing ? '⏸ Stop' : '▶ Play band';
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

  // ● toggles capture; while reviewing a take it starts a fresh one (back to live first).
  recordBtn.addEventListener('click', () => {
    if (state.recActive) { stopRecording(); return; }
    if (state.view === 'playback') enterLive();
    if (!state.running) {
      try { ensureAudioCtx(); } catch (_) {}
      setStatus('Tap ▶ to start the mic, then ● to record.');
      return;
    }
    startRecording();
  });

  playBandBtn.addEventListener('click', () => {
    if (state.playSource) stopSelectionPlayback();
    else playSelection();
  });
  selectAllBtn.addEventListener('click', selectAll);
  saveBandBtn.addEventListener('click', saveSelection);
  backLiveBtn.addEventListener('click', enterLive);
  selCanvas.addEventListener('pointerdown', onSelDown);
  selCanvas.addEventListener('pointermove', onSelMove);
  selCanvas.addEventListener('pointerup', onSelUp);
  selCanvas.addEventListener('pointercancel', onSelUp);

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

  // After an appearance change, repaint the static recording and refresh the
  // selection's frequency readout (its Hz depend on the y→freq mapping).
  function refreshStatic() {
    if (state.view !== 'playback') return;
    if (state.sel) {
      const hCss = selCanvas.getBoundingClientRect().height;
      state.sel.fHi = freqAtY(state.sel.y0, hCss);
      state.sel.fLo = freqAtY(state.sel.y1, hCss);
      selInfo.textContent = `${Math.round(state.sel.fLo)}–${Math.round(state.sel.fHi)} Hz · ${state.sel.t0.toFixed(2)}–${state.sel.t1.toFixed(2)} s`;
    }
    renderStaticSpectrogram();
  }

  fftSelect.addEventListener('change', () => {
    applyFft();
    if (state.running) setStatus(`FFT ${state.analyser.fftSize}.`);
    refreshStatic();
  });

  colorSelect.addEventListener('change', () => {
    state.colormap = colorSelect.value;
    state.lut = buildLut(state.colormap);
    refreshStatic();
  });

  logToggle.addEventListener('change', () => {
    state.log = logToggle.checked;
    drawAxis();
    refreshStatic();
  });

  // Rainbow draws its own per-zone palette, so the global Colors picker has
  // no effect there — hide it to keep the panel honest.
  function syncModeControls() {
    colorGroup.style.display = state.mode === 'rainbow' ? 'none' : '';
  }

  modeSelect.addEventListener('change', () => {
    state.mode = modeSelect.value;
    clearCanvas();
    state.acc = 0; // classic scroll accumulator: no burst when switching back
    syncModeControls();
    drawAxis();
    refreshStatic();
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
    refreshStatic();
  }
  minFreqInput.addEventListener('change', applyFreqRange);
  maxFreqInput.addEventListener('change', applyFreqRange);

  floorRange.addEventListener('input', () => {
    state.floor = parseFloat(floorRange.value);
    floorVal.textContent = state.floor;
    refreshStatic();
  });
  ceilRange.addEventListener('input', () => {
    state.ceil = parseFloat(ceilRange.value);
    ceilVal.textContent = state.ceil;
    refreshStatic();
  });
  smoothRange.addEventListener('input', () => {
    const v = parseFloat(smoothRange.value);
    smoothVal.textContent = v.toFixed(2);
    if (state.analyser) state.analyser.smoothingTimeConstant = v;
  });
  contrastRange.addEventListener('input', () => {
    state.gamma = parseFloat(contrastRange.value);
    contrastVal.textContent = state.gamma.toFixed(1);
    refreshStatic();
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
  syncModeControls();
  renderPlay();
  renderRecord();
  if (typeof MediaRecorder === 'undefined') recordBtn.disabled = true;

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
