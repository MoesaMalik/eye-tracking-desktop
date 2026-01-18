# Eye Tracking Desktop

> A robust desktop application for executing slide-based eye-tracking protocols, managing patient sessions, and analyzing gaze data for **concussion assessment** and monitoring.

## 📖 About The Project

**Eye Tracking Desktop** is a specialized tool designed for researchers and clinicians to conduct eye-tracking assessments, specifically tailored for **concussion patients**. Built with modern web technologies and a powerful Python backend, it offers a seamless workflow for patient management, protocol execution, and data collection.

The application captures real-time gaze data using computer vision (MediaPipe) and correlates it with visual stimuli presented on screen, exporting precise timings and metrics for analysis.

### ✨ Key Features

*   **Patient Management**: Create and manage patient profiles for organized data recording.
*   **Protocol Library**: Built-in protocols including Calibration, Saccades, Sentences, and Smooth Pursuit.
*   **Real-time Feedback**: Intelligent "Head Positioning" system ensures the user is correctly aligned before starting any test.
*   **Data Export**: Sessions are recorded and exported as anonymous JSON datasets for easy privacy-compliant analysis.
*   **Hybrid Architecture**: Combines the responsive UI of React with the computational power of Python's scientific stack.

### 🛠️ Built With

*   **Frontend**: [Electron](https://www.electronjs.org/), [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS](https://tailwindcss.com/)
*   **Backend**: Python, [OpenCV](https://opencv.org/), [MediaPipe](https://developers.google.com/mediapipe)
*   **Build Tool**: [Vite](https://vitejs.dev/)

---

## 🚀 Getting Started

Follow these steps to set up the development environment locally.

### Prerequisites

*   **Node.js**: Version 20+ (22.x recommended)
*   **Python**: Version 3.10+
*   **Git LFS**: Required if protocols contain large assets (`git lfs install`)

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/your-repo/eye-tracking-desktop.git
    cd eye-tracking-desktop
    ```

2.  **Set up the Python Backend**
    ```bash
    # Create a virtual environment
    python3 -m venv .venv
    
    # Activate the environment
    # On Windows:
    . .venv/scripts/activate
    # On macOS/Linux:
    # source .venv/bin/activate
    
    # Install Python dependencies
    pip install -U pip
    pip install -r tracker/requirements.txt
    ```

3.  **Install Frontend Dependencies**
    ```bash
    npm ci
    ```

### Running the App

To start the application in development mode (with hot-reloading):

```bash
npm run dev
```
This will launch the Electron window and spawn the Python tracker process in the background.

## 🧪 Testing

### Python Backend
The project includes a substantial test suite for the Python backend logic.

```bash
# Ensure your virtual environment is active
. .venv/scripts/activate

# Run the backend tests
pytest tracker/tests
```

### Frontend
The React components and logic are tested using **Vitest**.

```bash
# Run frontend tests
npm test
```

## 🏗️ Project Structure

The codebase is organized into three main distinct parts:

*   **`src/`**: The React frontend application (UI, Pages, Components).
*   **`electron/`**: The Electron main process and preload scripts (OS integration, window management).
*   **`tracker/`**: The Python backend that handles webcam input, computer vision, and data processing.

```text
eye-tracking-desktop/
├── docs/            # Project documentation
├── electron/        # Main process & IPC bridge
├── src/             # React UI code
│   ├── pages/       # Application views (Patients, Recorder, etc.)
│   └── lib/         # Shared utilities
├── tracker/         # Python computer vision & logic
│   ├── tests/       # Python unit tests
│   └── main.py      # Entry point for the tracker process
├── public/          # Static assets & protocol definitions
└── dist/            # Production build output
```

## ⚙️ Technical Details

### IPC & Architecture
The application uses a secure **IPC (Inter-Process Communication)** bridge to talk between the React UI and the Electron Main process. The Main process then spawns the Python tracker as a subprocess, communicating via `stdin`/`stdout`.

### Live Head Positioning
To ensure data quality, the app includes a "Live Head Positioning" mode. This runs a lightweight vision loop that provides real-time feedback on the user's position (distance, centralization) before a rigorous test begins.

*   **Source**: `tracker/live_head_position.py`
*   **Debug CLI**:
    ```bash
    python -m tracker.live_head_position --cam 0 --fps 30
    ```
