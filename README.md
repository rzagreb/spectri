# Spectri

A lightweight, standalone browser spectrogram visualizer for live microphone audio. Static app that runs entirely in the browser. No server, no build step, no dependencies.

**Access here:** [https://rzagreb.github.io/spectri/app](https://rzagreb.github.io/spectri/app)

## Features

- Live microphone
- Scrolling spectrogram
- Record & replay: capture a session, then drag a box on the static spectrogram
  to isolate a time × frequency region and hear just that band (highpass+lowpass
  filtering), with a sweeping playback cursor
- Select all + export the selection (or whole take) to a WAV file
- Controlls:
  - Start/Stop, Pause/Resume
  - FFT size: 256, 512, 1024, 2048, 4096
  - dB floor & ceiling
  - Smoothing time constant
  - Contrast (dynamic range)
  - Scroll speed
- Min/Max frequency range
- Linear, logarithmic frequency axis with labeled ticks
- Color schemes: Viridis, Magma, Inferno, Jet, Grayscale
- Input device picker + live level/clip meter
- Save PNG snapshot and Fullscreen mode
