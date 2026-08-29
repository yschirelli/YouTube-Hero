# YouTube Hero — AI-Powered YouTube Rhythm Game

[![Version](https://img.shields.io/badge/Version-4.0.0-brightgreen.svg)](package.json)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows-blue.svg)](https://www.electronjs.org/)
[![Electron](https://img.shields.io/badge/Electron-28.3.3-47848F.svg)](https://www.electronjs.org/)
[![AI Engine](https://img.shields.io/badge/AI-Spotify%20Basic%20Pitch%20%2B%20Open--Unmix-FF5722.svg)](https://github.com/spotify/basic-pitch)
[![PyTorch](https://img.shields.io/badge/PyTorch-Audio%20Stem%20Separation-EE4C2C.svg)](https://pytorch.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow.svg)](LICENSE)

**YouTube Hero** is an open-source, AI-driven rhythm game built with Electron and HTML5/WebGL. Simply paste any YouTube link or search query, and the game's neural network pipeline will download the audio, separate vocal stems, perform polyphonic pitch and onset detection, and generate a 5-lane guitar hero chart in real time.

---

## Table of Contents
- [Core Features](#core-features)
- [How It Works (AI & Audio Pipeline)](#how-it-works-ai--audio-pipeline)
- [Controls & Keybindings](#controls--keybindings)
- [System Requirements](#system-requirements)
- [Quick Start & Launcher](#quick-start--launcher)
- [Manual Setup & Execution](#manual-setup--execution)
- [Packaging & Distribution](#packaging--distribution)
- [AI Optimization & Auto-Tuning](#ai-optimization--auto-tuning)
- [Project Architecture](#project-architecture)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [License](#license)

---

## Core Features

- 🎵 **Direct YouTube Integration**: Search for any song or paste a YouTube URL directly; the engine streams, downloads, and processes audio locally.
- 🧠 **AI Stem Separation (Open-Unmix)**: Uses PyTorch neural network stem separation (`umxhq`) to remove vocal interference and isolate backing instrumentals for clean rhythm detection.
- 🎸 **Polyphonic Pitch & Beat Tracking**: Combines Spotify's **Basic Pitch** (TensorFlow.js) neural network with multi-band **Spectral Flux** onset detection.
- ⚡ **Dynamic 5-Lane Rhythm Highway**: Canvas/WebGL rendering with smooth 60+ FPS note scrolling, particle bursts, sustain holds, and dynamic combo multipliers.
- 🎯 **Multiple Difficulty Tiers**: Easy, Medium, and Hard profiles with adaptive chord sizes, quantize subdivisions, and note density scaling.
- 💾 **Local Offline Caching**: Automatically saves tracks, separated audio stems, user high scores, play histories, and generated note charts for instantaneous replays.
- 🎛️ **Simulated Annealing Auto-Tuner**: Built-in machine learning optimizer (`optimize_maps.py`) that tunes beat generator parameters for maximum musical accuracy.
- 🛠️ **Full In-Game Customization**: Audio latency calibration offset (ms), customizable keybindings, debug overlays, and hit sound toggles.

---

## How It Works (AI & Audio Pipeline)

```mermaid
flowchart LR
    A[YouTube URL / Search] --> B[youtube-dl-exec + FFmpeg]
    B --> C[Raw WAV Audio Track]
    C --> D[PyTorch Open-Unmix umxhq]
    D --> E[Isolated Instrumental Stem]
    E --> F[Spotify Basic Pitch + Spectral Flux]
    F --> G[Dynamic 5-Lane Chart Generator]
    G --> H[Interactive Rhythm Highway]
```

1. **Audio Extraction**: `youtube-dl-exec` fetches the best audio stream and converts it to high-fidelity 44.1kHz WAV via FFmpeg.
2. **Stem Isolation**: The Python backend runs Open-Unmix to split vocals from drums, bass, and guitar.
3. **Onset & Pitch Extraction**: `beatgen.js` processes harmonic spectral flux and pitch contours to detect musical notes and quantize them to the beat grid.
4. **Lane Allocation**: Notes are intelligently assigned across 5 lanes based on pitch frequency and hand ergonomics.

---

## Controls & Keybindings

### In-Game Highway Controls (Default)

| Action / Lane | Default Key | Customizable in Settings |
| :--- | :---: | :---: |
| **Lane 1 (Green)** | **`A`** | Yes |
| **Lane 2 (Red)** | **`S`** | Yes |
| **Lane 3 (Yellow)** | **`J`** | Yes |
| **Lane 4 (Blue)** | **`K`** | Yes |
| **Lane 5 (Orange)** | **`L`** | Yes |
| **Toggle Audio Stem (Vocal / Instrumental)** | **`Q`** | Yes |
| **Pause / Resume** | **`Escape`** | No |

---

## System Requirements

### Prerequisites
- **Node.js**: `v18.0.0` or later
- **npm**: `v9.0.0` or later
- **Python**: `3.10` or `3.11` (for AI stem separation and map optimizer)
- **FFmpeg**: Bundled automatically via `@ffmpeg-installer/ffmpeg`

---

## Quick Start & Launcher

The easiest way to run and manage YouTube Hero is via the interactive terminal launcher:

```bash
cd "Youtube Hero"
chmod +x launcher.sh
./launcher.sh
```

**Launcher Menu Options:**
1. **Launch Game (Electron)** — Starts the game in development/play mode.
2. **Run AI Parameter Optimization** — Runs simulated annealing to tune detection weights.
3. **Build Linux AppImage** — Compiles a standalone Linux AppImage package.
4. **Build Windows Executable** — Compiles a Windows installer (`.exe`) via Wine.
5. **Exit**

---

## Manual Setup & Execution

### 1. Install Node Dependencies
```bash
cd "Youtube Hero"
npm install
```

### 2. (Optional) Set up Python AI Environment
If you want to use local PyTorch stem separation and the auto-tuner:
```bash
python3 -m venv venv
./venv/bin/pip install torch torchvision torchaudio librosa soundfile numpy imageio-ffmpeg
```

### 3. Launch Development Server
```bash
npm start
```

---

## Packaging & Distribution

YouTube Hero is configured with `electron-builder` to package portable executables with bundled Python environments.

### Linux AppImage Build
```bash
npm run dist:linux
```
Output: `dist/YouTube Hero-4.0.0.AppImage`

### Windows Installer / Portable Executable
```bash
npm run dist:win
```
Output: `dist/YouTube Hero Setup 4.0.0.exe` and portable binary.

---

## AI Optimization & Auto-Tuning

The engine includes a **Simulated Annealing optimizer** (`ai_trainer/optimize_maps.py`) that calibrates note generation parameters against musical ground truth:

```bash
./venv/bin/python ai_trainer/optimize_maps.py
```

**Optimized Parameters (`engine_params.json`):**
- Cooldown interval between consecutive onsets
- Rhythm subdivision quantization grids
- Relative pitch semitone thresholds
- Basic Pitch onset & frame tolerances
- Energy tolerance and multi-band frequency filters

---

## Project Architecture

```text
Youtube Hero/
├── package.json                 # Project configuration and Electron dependencies
├── launcher.sh                  # Interactive management shell script
├── main.js                      # Electron main process (Audio downloading, caching, IPC)
├── preload.js                   # Secure contextBridge API definition
├── engine_params.json           # Active AI beat generation configuration
├── build_prep.js                # Build preparation script for cross-platform venvs
├── src/
│   ├── index.html               # Main UI view layout
│   ├── styles.css               # Cyberpunk neon aesthetic & responsive CSS
│   ├── renderer.js              # Highway canvas renderer, audio sync, & UI events
│   ├── beatgen.js               # Spectral Flux & Melodia note generation engine
│   ├── basic-pitch-wrapper.js   # Spotify Basic Pitch integration
│   ├── basic-pitch.bundle.js    # Bundled neural network runtime
│   └── model/                   # Basic Pitch TensorFlow.js weights
├── ai_trainer/
│   ├── separate_vocals.py       # PyTorch Open-Unmix stem separation script
│   ├── optimize_maps.py         # Simulated Annealing parameter auto-tuner
│   └── analyze_structure.py     # Song structure and energy profile analyzer
└── data/                        # Local runtime cache (Indexed tracks, stems, high scores)
    ├── audio/                   # Downloaded WAVs and separated instrumentals
    ├── cache_index.json         # Cache metadata registry
    └── user_stats.json          # High scores, favorites, and history
```

---

## Troubleshooting & FAQ

- **FFmpeg binary error on Linux/Windows**: Verify `@ffmpeg-installer/ffmpeg` is installed or ensure `ffmpeg` is available in your system `$PATH`.
- **YouTube download fails**: YouTube frequently updates stream endpoints. Update `youtube-dl-exec` via `npm update youtube-dl-exec` or update the underlying `yt-dlp` binary.
- **Audio Desync during gameplay**: Open Settings in-game and adjust the **Audio Latency Calibration Offset** (in milliseconds) until the highway hitline matches your sound output.

---

## License

This project is licensed under the [ISC License](LICENSE).
