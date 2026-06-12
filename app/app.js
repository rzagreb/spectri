/* Spectri — live microphone spectrogram.
 * Vanilla Web Audio API + Canvas 2D. No dependencies, no build step. */
(() => {
  'use strict';

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const startBtn = $('startBtn');
  const pauseBtn = $('pauseBtn');
  const clearBtn = $('clearBtn');
  const saveBtn = $('saveBtn');
  const fullscreenBtn = $('fullscreenBtn');
  const settingsBtn = $('settingsBtn');
  const settingsClose = $('settingsClose');
  const deviceSelect = $('deviceSelect');
  const fftSelect = $('fftSelect');
  const colorSelect = $('colorSelect');
  const logToggle = $('logToggle');
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
  const meterFill = $('meterFill');
  const meterEl = $('meter');
  const canvas = $('spectrogram');
  const axisCanvas = $('freqAxis');
  const canvasWrap = $('canvasWrap');
  const overlay = $('overlay');
  const statusEl = $('status');

  const ctx = canvas.getContext('2d', { alpha: false });
  const axisCtx = axisCanvas.getContext('2d');

  // ---- State ----
  const state = {
    audioCtx: null,
    analyser: null,
    source: null,
    stream: null,
    freqData: null,      // Float32Array (dB)
    timeData: null,      // Uint8Array (waveform for level meter)
    running: false,
    paused: false,
    rafId: 0,
    floor: -100,
    ceil: -30,
    speed: 2,
    gamma: 0.9,
    log: false,
    colormap: 'viridis',
    lut: null,
    fmin: 20,    // displayed min frequency (Hz)
    fmax: 18000, // displayed max frequency (Hz)
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
  function draw() {
    state.rafId = requestAnimationFrame(draw);
    if (!state.running) return;

    state.analyser.getByteTimeDomainData(state.timeData);
    updateMeter();

    if (state.paused) return;

    state.analyser.getFloatFrequencyData(state.freqData);

    const w = canvas.width, h = canvas.height;
    const speed = state.speed;
    const binCount = state.analyser.frequencyBinCount;
    const nyquist = state.audioCtx.sampleRate / 2;
    const range = (state.ceil - state.floor) || 1;
    const lut = state.lut;

    // Scroll existing content left by `speed` device pixels.
    ctx.drawImage(canvas, speed, 0, w - speed, h, 0, 0, w - speed, h);

    // Build the newest column (height h), then stamp it `speed` px wide.
    const col = ctx.createImageData(speed, h);
    const data = col.data;
    const { fmin, fmax } = freqRange(nyquist);
    const logDen = Math.log(fmax / fmin);
    const linSpan = fmax - fmin;

    const maxBin = binCount - 1;
    for (let y = 0; y < h; y++) {
      // y=0 is top → highest displayed frequency.
      const frac = 1 - y / (h - 1 || 1);
      const freq = state.log ? fmin * Math.exp(frac * logDen) : fmin + frac * linSpan;
      let binF = (freq / nyquist) * maxBin;
      if (binF < 0) binF = 0; else if (binF > maxBin) binF = maxBin;

      // Linearly interpolate between adjacent bins so sparse low-frequency
      // bins render as smooth gradients instead of blocky bands.
      const b0 = binF | 0;
      const b1 = b0 < maxBin ? b0 + 1 : b0;
      const t = binF - b0;
      const db = state.freqData[b0] * (1 - t) + state.freqData[b1] * t;
      let n = (db - state.floor) / range;
      if (n < 0) n = 0; else if (n > 1) n = 1;
      // Contrast curve: pushes weak noise toward black while keeping strong
      // signal bright, giving a crisper image (gamma=1 is the linear mapping).
      n = Math.pow(n, state.gamma);
      const li = (n * 255) | 0;
      const r = lut[li * 3], g = lut[li * 3 + 1], b = lut[li * 3 + 2];

      for (let x = 0; x < speed; x++) {
        const p = (y * speed + x) * 4;
        data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      }
    }
    ctx.putImageData(col, w - speed, 0);
  }

  function updateMeter() {
    const td = state.timeData;
    let sum = 0, peak = 0;
    for (let i = 0; i < td.length; i++) {
      const v = (td[i] - 128) / 128;
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / td.length);
    meterFill.style.width = Math.min(100, rms * 140) + '%';
    if (peak > 0.98) meterEl.classList.add('clip');
    else meterEl.classList.remove('clip');
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
      startBtn.textContent = 'Stop';
      startBtn.classList.add('recording');
      pauseBtn.disabled = false;
      pauseBtn.textContent = 'Pause';
      saveBtn.disabled = false;
      deviceSelect.disabled = false;

      const nyquist = Math.round(state.audioCtx.sampleRate / 2);
      maxFreqInput.max = nyquist;
      minFreqInput.max = nyquist;

      await populateDevices();
      resizeCanvas();
      drawAxis();
      setStatus(`Listening — ${Math.round(state.audioCtx.sampleRate / 1000)} kHz, FFT ${state.analyser.fftSize}.`);

      if (!state.rafId) draw();
    } catch (err) {
      handleError(err);
    }
  }

  function stop() {
    state.running = false;
    state.paused = false;
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = 0; }
    if (state.source) { try { state.source.disconnect(); } catch (_) {} state.source = null; }
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    startBtn.textContent = 'Start';
    startBtn.classList.remove('recording');
    pauseBtn.disabled = true;
    meterFill.style.width = '0%';
    meterEl.classList.remove('clip');
    setStatus('Stopped.');
  }

  function applyFft() {
    if (!state.analyser) return;
    state.analyser.fftSize = parseInt(fftSelect.value, 10);
    state.freqData = new Float32Array(state.analyser.frequencyBinCount);
    state.timeData = new Uint8Array(state.analyser.fftSize);
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

  startBtn.addEventListener('click', () => {
    if (state.running) { stop(); return; }
    try { ensureAudioCtx(); } catch (_) { /* start() surfaces real failures */ }
    start();
  });

  pauseBtn.addEventListener('click', () => {
    if (!state.running) return;
    state.paused = !state.paused;
    pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
    setStatus(state.paused ? 'Paused (mic still live).' : 'Listening…');
  });

  function clearCanvas() {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  clearBtn.addEventListener('click', clearCanvas);

  saveBtn.addEventListener('click', () => {
    try {
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `spectri-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
    } catch (err) { handleError(err); }
  });

  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (canvasWrap.requestFullscreen) {
      canvasWrap.requestFullscreen();
    }
  });

  // Show/hide the settings panel. On desktop the panel is inline so toggling it
  // changes the stage height — resizeCanvas() reflows the canvas (and redraws
  // the axis) while preserving the current image.
  function toggleSettings(open) {
    const next = open === undefined ? !document.body.classList.contains('settings-open') : open;
    document.body.classList.toggle('settings-open', next);
    settingsBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    resizeCanvas();
  }
  settingsBtn.addEventListener('click', () => toggleSettings());
  settingsClose.addEventListener('click', () => toggleSettings(false));

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
  document.addEventListener('fullscreenchange', () => setTimeout(resizeCanvas, 50));

  // ---- Helpers ----
  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
  }

  function handleError(err) {
    console.error(err);
    let msg = err && err.message ? err.message : String(err);
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      msg = 'Microphone access was denied. Allow it in your browser, then click Start again.';
    } else if (err && err.name === 'NotFoundError') {
      msg = 'No microphone found. Connect an input device and try again.';
    }
    setStatus(msg, true);
    stop();
  }

  // ---- Init ----
  // Browsers restore form-control values across refresh, which would desync the
  // UI from `state`. Force every control back to its default on load so the
  // chart always starts from the documented defaults.
  const DEFAULTS = {
    fft: '2048', color: 'viridis', log: false,
    floor: -100, ceil: -30, smooth: 0.5, speed: 2, gamma: 0.9,
    fmin: 20, fmax: 18000,
  };
  function initControls() {
    fftSelect.value = DEFAULTS.fft;
    colorSelect.value = DEFAULTS.color;
    logToggle.checked = DEFAULTS.log;
    minFreqInput.value = DEFAULTS.fmin;
    maxFreqInput.value = DEFAULTS.fmax;
    floorRange.value = DEFAULTS.floor;
    ceilRange.value = DEFAULTS.ceil;
    smoothRange.value = DEFAULTS.smooth;
    contrastRange.value = DEFAULTS.gamma;
    speedRange.value = DEFAULTS.speed;

    state.log = DEFAULTS.log;
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

  // Settings panel starts open on wide screens, collapsed on phones (where it
  // is an overlay drawer that would otherwise cover the spectrogram).
  if (window.matchMedia('(min-width: 641px)').matches) {
    document.body.classList.add('settings-open');
    settingsBtn.setAttribute('aria-expanded', 'true');
  }

  // iPhone Safari has no Fullscreen API for non-<video> elements, so the button
  // would silently do nothing — hide it where it isn't supported.
  if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) {
    fullscreenBtn.hidden = true;
  }

  state.lut = buildLut(state.colormap);
  resizeCanvas();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('This browser does not support microphone capture (getUserMedia).', true);
    startBtn.disabled = true;
  } else {
    setStatus('Ready. Click Start to begin.');
  }
})();
