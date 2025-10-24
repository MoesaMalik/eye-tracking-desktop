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
npm ci
npm run dev      # launches Vite + Electron

electron/
  main.ts            # BrowserWindow, dev/prod loader
  preload.ts         # (optional) preload bridge

src/
  main.tsx           # React entry, HashRouter
  App.tsx            # App shell + top nav
  pages/
    Patients.tsx     # create/select patient (anonymous code)
    RunTest.tsx      # pick protocol, start/end session, export JSON
  store/
    patientStore.ts  # Zustand store (patients, sessions)
  lib/
    save.ts          # saveJSON helper
  index.css          # Tailwind entry

public/
  protocols.json     # manifest mapping protocols → slide arrays
  assets/protocols/<task>/SlideN.PNG
  icon.ico | icon.png