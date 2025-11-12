# Eye-Tracking Desktop (Dev)

Electron + React + TypeScript + Vite + Tailwind  
Slide-based protocols (Calibration / Saccades / Sentences / Smooth Pursuit), run a session for a **selected patient**, record slide timings, export **anonymous JSON**.

---

## Quick Start

**Prereqs**
- Node.js 20+ (22.x recommended), npm 10+
- (If slides are large) `git lfs install`

**Install & Run (dev)**
```bash

python3 -m venv .venv
. .venv/bin/activate
pip install -U pip
pip install -r tracker/requirements.txt


npm ci
npm run dev      # launches Vite + Electron

electron/
  main.ts        # BrowserWindow, dev/prod loader, spawns Python tracker
  preload.ts     # IPC bridge → window.nativeApi / window.tracker

src/
  main.tsx       # React entry
  App.tsx        # Shell + top nav
  pages/
    Patients.tsx
    RunTest.tsx  # session control + JSON export
    Recorder.tsx # start/stop tracker, logs, PID/exit
  lib/
    save.ts
    tracker.ts   # typed wrapper for preload IPC
  vite-env.d.ts  # window.nativeApi / window.tracker types
  index.css      # Tailwind entry

public/
  protocols.json   # protocol → slide list
  assets/protocols/<task>/SlideN.png
  icon.ico | icon.png

tracker/
  main.py          # record/fallback + MediaPipe analysis
  requirements.txt # Python deps
  sample.mp4       # used if no webcam
