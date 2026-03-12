# Eye-Tracking Desktop

A research application for conducting eye-tracking sessions with real-time analysis. This app helps researchers run standardized eye-tracking protocols (Saccades, Sentences, Smooth Pursuit) and analyze the results.

---

##  What This App Does

- **Run Eye-Tracking Sessions**: Display slides to participants while recording their eye movements
- **Manage Patient Records**: Keep track of participants (anonymized with codes like P-7G2Q)
- **Analyze Results**: Process recorded videos and export anonymous data for research
- **Compare Sessions**: See how eye-tracking metrics change across multiple test sessions

---

##  Before You Start

You'll need to install two things on your computer:

1. **Node.js** (version 20 or newer, 22.x recommended)
   - Download from: https://nodejs.org/
   - Choose the "LTS" (Long Term Support) version
   - Installation includes npm (Node Package Manager)

2. **Python** (version 3.8 or newer)
   - Download from: https://www.python.org/downloads/
   - ⚠️ **Windows users**: Check "Add Python to PATH" during installation!

### How to Check if You Have Them Installed

Open your terminal (see below for how) and type these commands:

```bash
node --version    # Should show v20.x.x or v22.x.x
npm --version     # Should show 10.x.x or higher
python3 --version # Should show 3.8.x or higher
```

If you see version numbers, you're good to go! If you see "command not found", you need to install the missing software.

---

##  Setup Guide

### Method 1: Using Antigravity (Recommended for Beginners)

**Antigravity** is a helpful tool that makes setup easier. 

1. Open Antigravity
2. Point it to this project folder
3. Follow the on-screen instructions - Antigravity will handle most of the setup for you!

---

### Method 2: Using Terminal (Step-by-Step)

Don't worry if you're not familiar with the terminal - just follow these steps carefully!

#### Step 1: Open Terminal

**On Mac:**
- Press `Command + Space` to open Spotlight
- Type "Terminal" and press Enter

**On Windows:**
- Press `Windows Key + R`
- Type "cmd" and press Enter

**On Linux:**
- Press `Ctrl + Alt + T`

#### Step 2: Navigate to the Project Folder

You need to tell the terminal where this project is located. Type `cd ` (with a space after it) and then drag the project folder into the terminal window. Press Enter.

Example:
```bash
cd /Users/yourname/Downloads/eye-tracking-desktop
```

#### Step 3: Set Up Python Environment

This creates an isolated environment for Python packages:

**On Mac/Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r tracker/requirements.txt
```

**On Windows:**
```bash
python -m venv .venv
.venv\Scripts\activate
pip install -U pip
pip install -r tracker/requirements.txt
```

**What do these commands do?**
- Line 1: Creates a virtual environment called `.venv`
- Line 2: Activates it (you'll see `(.venv)` appear before your prompt)
- Line 3: Updates pip (the Python package installer)
- Line 4: Installs all required Python packages

⚠️ **Important**: You'll need to activate the virtual environment (`source .venv/bin/activate` or `.venv\Scripts\activate`) every time you open a new terminal window!

#### Step 4: Install Node Dependencies

```bash
npm ci
```

This installs all the JavaScript packages needed to run the app. It might take a few minutes.

**What's the difference between `npm ci` and `npm install`?**
- `npm ci` is cleaner and faster - it's what we use in projects!

#### Step 5: Run the Application

```bash
npm run dev
```

This starts the development server and launches the application. You should see an Electron window open with the Eye-Tracking Desktop interface!

**The app will show:**
- Patients page (manage participants)
- Run Test page (conduct eye-tracking sessions)
- Results page (view and compare session data)
- Analyze page (process recordings)
- Process External page (batch process external videos)

---

## Common Commands

Once you've completed the setup, here are the commands you'll use regularly:

### Running the App (Development Mode)

```bash
# Make sure you're in the project folder
cd /path/to/eye-tracking-desktop

# Activate Python environment (Mac/Linux)
source .venv/bin/activate

# Activate Python environment (Windows)
.venv\Scripts\activate

# Start the app
npm run dev
```

### Building for Distribution

If you want to create an installable version of the app:

```bash
npm run build    # Compile the code
npm run dist     # Create installer (.exe, .dmg, or .AppImage)
```

The installer will be created in the `dist/` folder.

---

## How to Use the Application

### 1. **Add a Patient**

- Go to the **Patients** page
- Fill in the form (initials and birth year are optional)
- Click "Add & Start Baseline"
- A unique anonymous code will be generated (e.g., P-7G2Q)

### 2. **Run a Test Session**

- You'll be taken to the **Run Test** page automatically
- Position the participant's head until you see "READY" status
- Select a protocol (Saccades, Sentences, or Smooth Pursuit)
- Click "Start Session"
- The slides will display fullscreen
- Press `n` (next) or `p` (previous) to navigate slides
- Press `Escape` to finish the session

### 3. **View Results**

- Go to the **Results** page
- Select a patient to see their session history
- If they have multiple sessions, click "Compare" to see differences

### 4. **Analyze Videos**

- Go to the **Analyze** page
- Load a recorded session video
- Auto-detect events or manually mark them
- Fit calibration models to the data
- Export results as JSON or CSV

---

## Troubleshooting

### "command not found" error

**Problem:** The terminal doesn't recognize `node`, `npm`, or `python3`

**Solution:**
- Make sure you've installed Node.js and Python (see "Before You Start")
- On Windows, you may need to restart your computer after installation
- Check that they're added to your PATH

### Python environment activation doesn't work

**Problem:** You see an error when running `source .venv/bin/activate`

**Solution (Mac/Linux):**
```bash
# Try with a dot instead of source
. .venv/bin/activate
```

**Solution (Windows PowerShell):**
```bash
# If you get a script execution error:
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
.venv\Scripts\Activate.ps1
```

### "Module not found" errors

**Problem:** The app won't start and shows missing module errors

**Solution:**
```bash
# Reinstall Node dependencies
npm ci

# Reinstall Python dependencies (make sure .venv is activated!)
pip install -r tracker/requirements.txt
```

### Camera not working

**Problem:** The app can't access your webcam

**Solution:**
- Check your system settings to allow camera access for the app
- Make sure no other app is using the camera
- Try restarting the app

### App window is blank or doesn't load

**Problem:** The Electron window opens but shows nothing

**Solution:**
```bash
# Clear the build and try again
npm run build
npm run dev
```

---

## Project Structure

Here's what the main folders contain:

```
eye-tracking-desktop/
├── src/                  # React app source code
│   ├── pages/           # Application pages (Patients, RunTest, etc.)
│   ├── components/      # Reusable UI components
│   └── store/           # State management (Zustand)
│
├── electron/            # Electron main process code
│   ├── main.ts         # App entry point, spawns Python processes
│   └── preload.ts      # Bridge between Electron and React
│
├── tracker/             # Python eye-tracking scripts
│   ├── main.py         # Core eye-tracking with MediaPipe
│   └── requirements.txt # Python dependencies
│
├── public/              # Static assets
│   ├── protocols.json  # Protocol definitions
│   └── assets/         # Slide images
│
└── recordings/          # Session data (created automatically)
```

---

## Getting Help

If you run into issues:

1. **Check this README** - especially the Troubleshooting section
2. **Ask your instructor** - they can help with setup
3. **Check the terminal output** - error messages often tell you what's wrong
4. **Make sure all prerequisites are installed** - Node.js and Python

---

## Privacy Note

This application is designed for research with privacy in mind:
- Patient records use anonymous codes (e.g., P-7G2Q)
- Only the code is included in exported data
- Personal information (initials, birth year, notes) stays on your computer
- No data is sent to external servers

---

## Technical Details

**For developers who want to know more:**

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS v4
- **Desktop**: Electron 30
- **Eye Tracking**: Python 3.8+ with MediaPipe 0.10.14
- **Data Viz**: Recharts
- **State Management**: Zustand
- **Routing**: React Router DOM v7

The app uses an Electron IPC bridge to communicate between the React frontend and Python eye-tracking scripts.

---

## Development Commands (Advanced)

```bash
# Linting (check code quality)
npm run lint

# Run tests
npm run test           # Run once
npm run test:watch     # Watch mode

# Build for production
npm run build          # Compile TypeScript + Vite
npm run dist           # Create distributable app

# Standalone Python scripts
python -m tracker.main --cam 0                      # Run tracker with preview
python -m tracker.live_head_position --cam 0 --fps 30  # Head positioning stream
python -m tracker.live_gaze_stream --cam 0 --fps 30    # Live gaze stream
```

---

## ✅ Quick Start Checklist

- [ ] Install Node.js (20+)
- [ ] Install Python (3.8+)
- [ ] Open terminal and navigate to project folder
- [ ] Create Python virtual environment (`.venv`)
- [ ] Activate virtual environment
- [ ] Install Python dependencies (`pip install -r tracker/requirements.txt`)
- [ ] Install Node dependencies (`npm ci`)
- [ ] Run the app (`npm run dev`)
- [ ] You should see the Eye-Tracking Desktop window open!

---
