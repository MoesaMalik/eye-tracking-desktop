# tracker/main.py
"""
Eye Tracker Module

This module provides functionality to:
1.  Record video from a webcam.
2.  Process the video to detect eyes and irises using MediaPipe FaceMesh.
3.  Refine the iris center detection using traditional computer vision techniques
    (Canny edge detection + Ellipse/Circle fitting).
4.  Export tracking data to CSV and JSON formats.

Key Components:
- `record_video`: Handles camera recording.
- `EyeTracker`: Main class for processing the recorded video.
"""
import os
import argparse
import signal
import shutil
import math
import cv2
import numpy as np
import pandas as pd
from pathlib import Path
import mediapipe as mp
from tqdm import tqdm
import json
import sys
import subprocess
from datetime import datetime

# Import from new modules
try:
    # Relative imports (when running as a package, e.g. python -m tracker.main)
    from .camera import record_video
    from .geometry import (
        get_eye_roi_dynamic, iris_center_radius, iris_center_ellipse, iris_center_circle,
        calculate_ear
    )
    from .visualizer import draw_overlay, VIS_COLORS
    from .filter import OneEuroFilter
    from .head_positioning import HeadPositioner
except (ImportError, ValueError):
    # Direct imports (when running as a script, e.g. python tracker/main.py)
    from camera import record_video
    from geometry import (
        get_eye_roi_dynamic, iris_center_radius, iris_center_ellipse, iris_center_circle,
        calculate_ear
    )
    from visualizer import draw_overlay, VIS_COLORS
    from filter import OneEuroFilter
    from head_positioning import HeadPositioner

os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_MSMF", "0")

stop_requested = False

def _handle_stop(signum, _frame):
    global stop_requested
    stop_requested = True
    print(f"\n[INFO] Received signal {signum}; stopping recording…")

# --------- Configuration ----------
CAM_INDEX = 0

# Confidence threshold for "hold last good value"
MIN_CONF = 0.4
# EAR Threshold for Blink
EAR_THRESHOLD = 0.20

# OneEuroFilter Smoothing Presets
# These are defaults - can be overridden via CLI args
SMOOTHING_PRESETS = {
    'off': {'min_cutoff': None, 'beta': None},  # No filtering
    'light': {'min_cutoff': 1.0, 'beta': 0.02},  # Minimal smoothing, very responsive
    'medium': {'min_cutoff': 0.5, 'beta': 0.01},  # Balanced
    'heavy': {'min_cutoff': 0.1, 'beta': 0.005},  # Heavy smoothing (old default was even heavier)
}

# Default smoothing mode
DEFAULT_SMOOTHING_MODE = 'light'

# Debug overlay: show raw (unsmoothed) iris centers
# Controlled by --show-raw-overlay CLI flag (default: False)
SHOW_RAW_OVERLAY = True

# Eye landmarks (MediaPipe FaceMesh indices) - Used for EAR
# Standard 6-point (P1, P2, P3, P4, P5, P6)
# Left: 33, 160, 158, 133, 153, 144
EAR_LEFT_IDX = [33, 160, 158, 133, 153, 144]
# Right: 362, 385, 387, 263, 373, 380
EAR_RIGHT_IDX = [362, 385, 387, 263, 373, 380]

# Iris landmark sets (with refine_landmarks=True)
LEFT_IRIS_IDX = [468, 469, 470, 471, 472]
RIGHT_IRIS_IDX = [473, 474, 475, 476, 477]

# ---------- Utilities ----------
def _find_sample_video():
    """
    Finds a sample video in the current directory.
    """
    p = Path(__file__).parent / "sample.mp4"
    if p.exists():
        return str(p)
    return None

def clear_output_dir(path="output"):
    """
    Deletes and recreates the output directory to ensure a clean state.
    
    Args:
        path (str): Path to the output directory.
    """
    out = Path(path)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

# -------------- Recorder / Processor --------------
class EyeTracker:
    """
    Main class that orchestrates video loading, processing, and tracking.
    """
    def __init__(self, video_path, output_dir="output", show_raw_overlay=False, 
                 smoothing_mode='light', min_cutoff=None, beta=None):
        self.video_path = Path(video_path)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.show_raw_overlay = show_raw_overlay
        
        # Smoothing configuration
        self.smoothing_mode = smoothing_mode
        if smoothing_mode == 'off':
            self.min_cutoff = None
            self.beta = None
        else:
            # Use preset values unless overridden
            preset = SMOOTHING_PRESETS.get(smoothing_mode, SMOOTHING_PRESETS['light'])
            self.min_cutoff = min_cutoff if min_cutoff is not None else preset['min_cutoff']
            self.beta = beta if beta is not None else preset['beta']

        self.cap = cv2.VideoCapture(str(video_path))
        if not self.cap.isOpened():
            raise RuntimeError(f"Cannot open video: {video_path}")

        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.duration_sec = self.total_frames / max(1e-6, self.fps)
        self.tracking_data = []

        self.last_left_center = None
        self.last_right_center = None
        # Origins used to produce zero-based coordinates that start at (0,0)
        # without changing existing absolute coordinate fields.
        self.coord_origins = {
            "left": None,
            "right": None,
            "gaze": None,
            "left_raw": None,
            "right_raw": None,
            "gaze_raw": None,
        }
        
        # Filters for smoothing (Lx, Ly, Rx, Ry)
        self.filter_lx = None
        self.filter_ly = None
        self.filter_rx = None
        self.filter_ry = None

        print(f"\n{'=' * 70}")
        print(f"VIDEO PROCESSING")
        print(f"{'=' * 70}")
        print(f"Resolution: {self.width}x{self.height}")
        print(f"FPS: {self.fps:.2f}")
        print(f"Total Frames: {self.total_frames}")
        print(f"Duration: {self.duration_sec:.2f}s")
        print(f"[overlay] raw overlay {'enabled' if self.show_raw_overlay else 'disabled'}")
        
        # Print smoothing config to stderr
        import sys
        if self.smoothing_mode == 'off':
            print(f"[smoothing] mode=off (no filtering)", file=sys.stderr)
        else:
            print(f"[smoothing] mode={self.smoothing_mode} min_cutoff={self.min_cutoff} beta={self.beta}", 
                  file=sys.stderr)
        
        print(f"{'=' * 70}\n")

    @staticmethod
    def _is_finite_number(value):
        return isinstance(value, (int, float, np.floating)) and math.isfinite(float(value))

    def _set_zero_based_pair(self, frame_data, src_x_key, src_y_key, out_x_key, out_y_key, origin_key):
        x = frame_data.get(src_x_key)
        y = frame_data.get(src_y_key)
        if not (self._is_finite_number(x) and self._is_finite_number(y)):
            frame_data[out_x_key] = float("nan")
            frame_data[out_y_key] = float("nan")
            return

        origin = self.coord_origins.get(origin_key)
        if origin is None:
            origin = (float(x), float(y))
            self.coord_origins[origin_key] = origin

        frame_data[out_x_key] = float(x) - origin[0]
        frame_data[out_y_key] = float(y) - origin[1]

    def process_video(self):
        """
        Runs the eye tracking pipeline on the video.
        
        Steps:
        1. Initialize MediaPipe FaceMesh to get rough iris location.
        2. Iterate through each frame of the video.
        3. For each frame, if a face is detected:
           - Extract ROI for each eye.
           - Attempt to fit an Ellipse or Circle to the iris edges.
           - Choose the best fit (Ellipse or Circle) based on confidence.
           - Apply temporal smoothing (holding last good value if low confidence).
           - Draw visualization overlay.
        4. Save video with overlay and tracking data.
        
        Returns:
            list: List of dictionaries containing tracking data for each frame.
        """
        # MediaPipe FaceMesh with iris landmarks
        mp_face_mesh = mp.solutions.face_mesh
        face_mesh = mp_face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )
        head_positioner = HeadPositioner()

        output_video_path = self.output_dir / f"{self.video_path.stem}_tracked.mp4"

        def _make_writer(path, fps_val, size):
            for codec in ['avc1', 'H264', 'mp4v']:
                fourcc = cv2.VideoWriter_fourcc(*codec)
                writer = cv2.VideoWriter(str(path), fourcc, fps_val, size)
                if writer.isOpened():
                    print(f"[INFO] Using codec {codec} for {path}")
                    return writer
                writer.release()
            raise RuntimeError("Could not create VideoWriter with avc1/H264/mp4v")

        video_writer = _make_writer(output_video_path, self.fps, (self.width, self.height))

        print("Processing...\n")
        use_ellipse_L = 0
        use_ellipse_R = 0

        for frame_idx in tqdm(range(self.total_frames), desc="Tracking", unit="frame"):
            ret, frame = self.cap.read()
            if not ret:
                break

            timestamp_sec = frame_idx / self.fps

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = face_mesh.process(rgb)

            frame_data = {
                'frame': frame_idx,
                'timestamp_sec': float(timestamp_sec),
                'time_formatted': f"{int(timestamp_sec // 60):02d}:{timestamp_sec % 60:06.3f}",
                'face_detected': False
            }

            head_result = None
            if result and result.multi_face_landmarks:
                lms = result.multi_face_landmarks[0].landmark
                frame_data['face_detected'] = True
                head_result = head_positioner.assess(lms)
                
                # Check Blinks (EAR)
                ear_l = calculate_ear(lms, EAR_LEFT_IDX, self.width, self.height)
                ear_r = calculate_ear(lms, EAR_RIGHT_IDX, self.width, self.height)
                frame_data['ear_left'] = float(ear_l)
                frame_data['ear_right'] = float(ear_r)
                
                is_blink = bool((ear_l < EAR_THRESHOLD) or (ear_r < EAR_THRESHOLD))
                frame_data['is_blink'] = is_blink

                # Eye box landmarks (for normalized calibration features)
                def _lm_xy(idx):
                    lm = lms[idx]
                    return lm.x * self.width, lm.y * self.height

                left_outer_x, left_outer_y = _lm_xy(33)
                left_inner_x, left_inner_y = _lm_xy(133)
                right_outer_x, right_outer_y = _lm_xy(362)
                right_inner_x, right_inner_y = _lm_xy(263)

                left_top_points = [_lm_xy(i) for i in [160, 158]]
                left_bottom_points = [_lm_xy(i) for i in [144, 153]]
                right_top_points = [_lm_xy(i) for i in [385, 387]]
                right_bottom_points = [_lm_xy(i) for i in [373, 380]]

                left_eye_left_x = min(left_outer_x, left_inner_x)
                left_eye_right_x = max(left_outer_x, left_inner_x)
                right_eye_left_x = min(right_outer_x, right_inner_x)
                right_eye_right_x = max(right_outer_x, right_inner_x)

                left_eye_top_y = min(pt[1] for pt in left_top_points)
                left_eye_bottom_y = max(pt[1] for pt in left_bottom_points)
                right_eye_top_y = min(pt[1] for pt in right_top_points)
                right_eye_bottom_y = max(pt[1] for pt in right_bottom_points)

                left_eye_top_x = sum(pt[0] for pt in left_top_points) / len(left_top_points)
                left_eye_bottom_x = sum(pt[0] for pt in left_bottom_points) / len(left_bottom_points)
                right_eye_top_x = sum(pt[0] for pt in right_top_points) / len(right_top_points)
                right_eye_bottom_x = sum(pt[0] for pt in right_bottom_points) / len(right_bottom_points)

                frame_data['left_eye_left_x'] = float(left_eye_left_x)
                frame_data['left_eye_right_x'] = float(left_eye_right_x)
                frame_data['left_eye_top_x'] = float(left_eye_top_x)
                frame_data['left_eye_top_y'] = float(left_eye_top_y)
                frame_data['left_eye_bottom_x'] = float(left_eye_bottom_x)
                frame_data['left_eye_bottom_y'] = float(left_eye_bottom_y)

                frame_data['right_eye_left_x'] = float(right_eye_left_x)
                frame_data['right_eye_right_x'] = float(right_eye_right_x)
                frame_data['right_eye_top_x'] = float(right_eye_top_x)
                frame_data['right_eye_top_y'] = float(right_eye_top_y)
                frame_data['right_eye_bottom_x'] = float(right_eye_bottom_x)
                frame_data['right_eye_bottom_y'] = float(right_eye_bottom_y)
                
                if is_blink:
                    cv2.putText(frame, "BLINK", (self.width // 2 - 40, self.height // 2),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                                
                    # If blink, we might want to hold the last valid gaze or just skip
                    # Here we'll just not update the detailed tracking logic and perhaps fill with NaN or last known
                    # But the drawing overlay expects keys. Let's fill with last known or skip logic.
                    # Simple approach: If blink, we skip the edge refinement and just use MP (smoothed) or nothing.
                    # Ideally, during a blink, gaze data is invalid.
                    
                    # We will skip the ellipse fitting part.
                    # But we need to ensure 'left_center_x' etc are present in frame_data for the overlay/CSV.
                    
                    # Implementation: We iterate through detection but if blink, we force low confidence or skip.
                    pass

                # MediaPipe iris rough center & radius (full-frame)
                lcx_mp, lcy_mp, lr = iris_center_radius(lms, LEFT_IRIS_IDX, self.width, self.height)
                rcx_mp, rcy_mp, rr = iris_center_radius(lms, RIGHT_IRIS_IDX, self.width, self.height)

                frame_data['left_mp_x'] = lcx_mp
                frame_data['left_mp_y'] = lcy_mp
                frame_data['right_mp_x'] = rcx_mp
                frame_data['right_mp_y'] = rcy_mp

                # Draw rough MP iris centers (green)
                # cv2.circle(frame, (int(round(lcx_mp)), int(round(lcy_mp))), 3, VIS_COLORS['rough'], 1)
                # cv2.circle(frame, (int(round(rcx_mp)), int(round(rcy_mp))), 3, VIS_COLORS['rough'], 1)

                # Initialize edge values in frame_data (NaN by default)
                for key in [
                    'left_lr_left_x', 'left_lr_left_y',
                    'left_lr_right_x', 'left_lr_right_y',
                    'left_tb_top_x', 'left_tb_top_y',
                    'left_tb_bottom_x', 'left_tb_bottom_y',
                    'right_lr_left_x', 'right_lr_left_y',
                    'right_lr_right_x', 'right_lr_right_y',
                    'right_tb_top_x', 'right_tb_top_y',
                    'right_tb_bottom_x', 'right_tb_bottom_y'
                ]:
                    frame_data[key] = float('nan')

                # If blink, skip standard processing
                if is_blink:
                     # Just use last known or NaN
                     frame_data['left_method'] = 'blink'
                     frame_data['right_method'] = 'blink'
                     
                     if self.last_left_center:
                         frame_data['left_center_x'] = self.last_left_center[0]
                         frame_data['left_center_y'] = self.last_left_center[1]
                         frame_data['left_confidence'] = 0.0
                     else:
                         frame_data['left_center_x'] = float('nan')
                         frame_data['left_center_y'] = float('nan')
                         frame_data['left_confidence'] = 0.0
                         
                     if self.last_right_center:
                         frame_data['right_center_x'] = self.last_right_center[0]
                         frame_data['right_center_y'] = self.last_right_center[1]
                         frame_data['right_confidence'] = 0.0
                     else:
                         frame_data['right_center_x'] = float('nan')
                         frame_data['right_center_y'] = float('nan')
                         frame_data['right_confidence'] = 0.0
                         
                     # We can skip the rest of the loop for this frame's eye processing (except overlay)
                     # But we need to make sure all expected keys are there.
                     # Let's wrap the "Tracking Logic" in an else block.
                
                else:
                    # Dynamic ROIs around iris (full-frame)
                    lx0, ly0, lx1, ly1 = get_eye_roi_dynamic(self.width, self.height, (lcx_mp, lcy_mp), lr)
                    rx0, ry0, rx1, ry1 = get_eye_roi_dynamic(self.width, self.height, (rcx_mp, rcy_mp), rr)
                    left_roi = frame[ly0:ly1, lx0:lx1]
                    right_roi = frame[ry0:ry1, rx0:rx1]

                    # Draw ROI boxes
                    cv2.rectangle(frame, (lx0, ly0), (lx1, ly1), VIS_COLORS['roi_box'], 1)
                    cv2.rectangle(frame, (rx0, ry0), (rx1, ry1), VIS_COLORS['roi_box'], 1)

                    # Store ROI boxes so calibration UI can use them
                    frame_data['left_roi_x0'] = float(lx0)
                    frame_data['left_roi_y0'] = float(ly0)
                    frame_data['left_roi_x1'] = float(lx1)
                    frame_data['left_roi_y1'] = float(ly1)

                    frame_data['right_roi_x0'] = float(rx0)
                    frame_data['right_roi_y0'] = float(ry0)
                    frame_data['right_roi_x1'] = float(rx1)
                    frame_data['right_roi_y1'] = float(ry1)

                    # ---- LEFT: try ellipse and circle, choose best by confidence ----
                    l_ell = iris_center_ellipse(left_roi, (lcx_mp - lx0, lcy_mp - ly0), lr)
                    l_cir = iris_center_circle(left_roi, (lcx_mp - lx0, lcy_mp - ly0), lr)


                    bestL = None
                    if l_ell and l_cir:
                        # prefer the model with higher confidence; slight bias to ellipse if very circular too
                        conf_ell = l_ell[2] * (0.9 + 0.1 * l_ell[4])  # boost if circular
                        conf_cir = l_cir[2]
                        bestL = ('ellipse', l_ell) if conf_ell >= conf_cir else ('circle', l_cir)
                    elif l_ell:
                        bestL = ('ellipse', l_ell)
                    elif l_cir:
                        bestL = ('circle', l_cir)

                    # Initialize edge values in frame_data (NaN by default)
                    for key in [
                        'left_lr_left_x', 'left_lr_left_y',
                        'left_lr_right_x', 'left_lr_right_y',
                        'left_tb_top_x', 'left_tb_top_y',
                        'left_tb_bottom_x', 'left_tb_bottom_y'
                    ]:
                        frame_data[key] = float('nan')

                    if bestL:
                        model_type, res = bestL
                        if model_type == 'ellipse':
                            cxR, cyR, conf, ellipse, circ, _, x_min, x_max, y_min, y_max = res
                            method_base = f'ellipse_fit(circ={circ:.2f})'
                            use_ellipse_L += 1
                        else:
                            cxR, cyR, conf, rad, _, x_min, x_max, y_min, y_max = res
                            method_base = 'circle_fit(taubin)'

                        lcx_abs = float(cxR + lx0)
                        lcy_abs = float(cyR + ly0)

                        if conf < MIN_CONF and self.last_left_center is not None:
                            # hold previous stable value
                            lcx_abs, lcy_abs = self.last_left_center
                            method = method_base + "_held(prev)"
                            conf_used = conf
                        else:
                            self.last_left_center = (lcx_abs, lcy_abs)
                            method = method_base
                            conf_used = conf
                        
                        # RAW values (before OneEuroFilter smoothing)
                        # These represent the chosen best-fit center for this frame
                        lcx_raw = lcx_abs  # Save raw before filtering
                        lcy_raw = lcy_abs
                        
                        # Apply OneEuroFilter (if smoothing enabled)
                        if self.smoothing_mode != 'off':
                            if self.filter_lx is None:
                                self.filter_lx = OneEuroFilter(timestamp_sec, lcx_abs, 
                                                               min_cutoff=self.min_cutoff, beta=self.beta)
                                self.filter_ly = OneEuroFilter(timestamp_sec, lcy_abs, 
                                                               min_cutoff=self.min_cutoff, beta=self.beta)
                            
                            lcx_abs = self.filter_lx(timestamp_sec, lcx_abs)
                            lcy_abs = self.filter_ly(timestamp_sec, lcy_abs)
                        # else: smoothing off, lcx_abs stays as raw value

                        frame_data['left_center_x'] = lcx_abs
                        frame_data['left_center_y'] = lcy_abs
                        frame_data['left_confidence'] = float(conf_used)
                        frame_data['left_method'] = method
                        
                        # Always store raw values in frame_data for analysis
                        frame_data['left_center_x_raw'] = float(lcx_raw)
                        frame_data['left_center_y_raw'] = float(lcy_raw)

                        # Draw final left iris center (yellow - smoothed)
                        cv2.circle(frame, (int(round(lcx_abs)), int(round(lcy_abs))),
                                   5, VIS_COLORS['mid'], -1)
                        
                        # Draw RAW left iris center (red crosshair) if debug overlay enabled
                        if self.show_raw_overlay:
                            # Draw small crosshair for raw position
                            rx, ry = int(round(lcx_raw)), int(round(lcy_raw))
                            crosshair_size = 6
                            cv2.line(frame, (rx - crosshair_size, ry), (rx + crosshair_size, ry), (0, 0, 255), 1)
                            cv2.line(frame, (rx, ry - crosshair_size), (rx, ry + crosshair_size), (0, 0, 255), 1)
                            cv2.circle(frame, (rx, ry), 2, (0, 0, 255), 1)  # Small circle at center

                        # Draw and store extrema if available
                        if x_min is not None:
                            # Left/right extrema
                            left_x_abs = lx0 + x_min
                            right_x_abs = lx0 + x_max
                            # Use iris center y for drawing LR extrema
                            left_y_abs = lcy_abs
                            right_y_abs = lcy_abs
                            cv2.circle(frame, (int(round(left_x_abs)), int(round(left_y_abs))),
                                       3, VIS_COLORS['extreme_lr'], -1)
                            cv2.circle(frame, (int(round(right_x_abs)), int(round(right_y_abs))),
                                       3, VIS_COLORS['extreme_lr'], -1)
                            frame_data['left_lr_left_x'] = float(left_x_abs)
                            frame_data['left_lr_left_y'] = float(left_y_abs)
                            frame_data['left_lr_right_x'] = float(right_x_abs)
                            frame_data['left_lr_right_y'] = float(right_y_abs)

                        if y_min is not None:
                            # Top/bottom extrema
                            top_y_abs = ly0 + y_min
                            bottom_y_abs = ly0 + y_max
                            # Use iris center x for drawing TB extrema
                            top_x_abs = lcx_abs
                            bottom_x_abs = lcx_abs
                            cv2.circle(frame, (int(round(top_x_abs)), int(round(top_y_abs))),
                                       3, VIS_COLORS['extreme_tb'], -1)
                            cv2.circle(frame, (int(round(bottom_x_abs)), int(round(bottom_y_abs))),
                                       3, VIS_COLORS['extreme_tb'], -1)
                            frame_data['left_tb_top_x'] = float(top_x_abs)
                            frame_data['left_tb_top_y'] = float(top_y_abs)
                            frame_data['left_tb_bottom_x'] = float(bottom_x_abs)
                            frame_data['left_tb_bottom_y'] = float(bottom_y_abs)
                    else:
                        # last resort: MP center (per-frame, still exact frame, no smoothing)
                        frame_data['left_center_x'] = float(lcx_mp)
                        frame_data['left_center_y'] = float(lcy_mp)
                        frame_data['left_confidence'] = 0.2
                        frame_data['left_method'] = 'iris_landmark_center'
                        self.last_left_center = (lcx_mp, lcy_mp)
                        # Reset filters if using MP fallback? Or continue? Let's continue filter to smooth the transition.
                        if self.filter_lx is None:
                             self.filter_lx = OneEuroFilter(timestamp_sec, lcx_mp, min_cutoff=ONE_EURO_MIN_CUTOFF, beta=ONE_EURO_BETA)
                             self.filter_ly = OneEuroFilter(timestamp_sec, lcy_mp, min_cutoff=ONE_EURO_MIN_CUTOFF, beta=ONE_EURO_BETA)
                        
                        smoothed_x = self.filter_lx(timestamp_sec, lcx_mp)
                        smoothed_y = self.filter_ly(timestamp_sec, lcy_mp)
                        frame_data['left_center_x'] = smoothed_x
                        frame_data['left_center_y'] = smoothed_y
                        
                        cv2.circle(frame, (int(round(smoothed_x)), int(round(smoothed_y))), 5, VIS_COLORS['mid'], -1)

                    # Compute left iris diameter (in full-frame pixels)
                    left_diam = float('nan')

                    # Prefer horizontal distance between LR extrema if available
                    if (
                        'left_lr_left_x' in frame_data and 'left_lr_right_x' in frame_data and
                        not np.isnan(frame_data['left_lr_left_x']) and
                        not np.isnan(frame_data['left_lr_right_x'])
                    ):
                        left_diam = frame_data['left_lr_right_x'] - frame_data['left_lr_left_x']

                    # Otherwise, try vertical distance between TB extrema
                    if np.isnan(left_diam) and (
                        'left_tb_top_y' in frame_data and 'left_tb_bottom_y' in frame_data and
                        not np.isnan(frame_data['left_tb_top_y']) and
                        not np.isnan(frame_data['left_tb_bottom_y'])
                    ):
                        left_diam = frame_data['left_tb_bottom_y'] - frame_data['left_tb_top_y']

                    # Fallback: use MediaPipe iris radius lr if still NaN
                    if np.isnan(left_diam):
                        left_diam = 2.0 * lr  # lr is the iris radius from iris_center_radius

                    frame_data['left_iris_diameter'] = float(left_diam)

                    # ---- RIGHT: ellipse vs circle ----
                    r_ell = iris_center_ellipse(right_roi, (rcx_mp - rx0, rcy_mp - ry0), rr)
                    r_cir = iris_center_circle(right_roi, (rcx_mp - rx0, rcy_mp - ry0), rr)

                    bestR = None
                    if r_ell and r_cir:
                        conf_ell = r_ell[2] * (0.9 + 0.1 * r_ell[4])
                        conf_cir = r_cir[2]
                        bestR = ('ellipse', r_ell) if conf_ell >= conf_cir else ('circle', r_cir)
                    elif r_ell:
                        bestR = ('ellipse', r_ell)
                    elif r_cir:
                        bestR = ('circle', r_cir)

                    # Initialize edge values in frame_data (NaN by default)
                    for key in [
                        'right_lr_left_x', 'right_lr_left_y',
                        'right_lr_right_x', 'right_lr_right_y',
                        'right_tb_top_x', 'right_tb_top_y',
                        'right_tb_bottom_x', 'right_tb_bottom_y'
                    ]:
                        frame_data[key] = float('nan')

                    if bestR:
                        model_type, res = bestR
                        if model_type == 'ellipse':
                            cxR, cyR, conf, ellipse, circ, _, x_min, x_max, y_min, y_max = res
                            method_base = f'ellipse_fit(circ={circ:.2f})'
                            use_ellipse_R += 1
                        else:
                            cxR, cyR, conf, rad, _, x_min, x_max, y_min, y_max = res
                            method_base = 'circle_fit(taubin)'

                        rcx_abs = float(cxR + rx0)
                        rcy_abs = float(cyR + ry0)

                        if conf < MIN_CONF and self.last_right_center is not None:
                            rcx_abs, rcy_abs = self.last_right_center
                            method = method_base + "_held(prev)"
                            conf_used = conf
                        else:
                            self.last_right_center = (rcx_abs, rcy_abs)
                            method = method_base
                            conf_used = conf
                        
                        # RAW values (before OneEuroFilter smoothing)
                        # These represent the chosen best-fit center for this frame
                        rcx_raw = rcx_abs  # Save raw before filtering
                        rcy_raw = rcy_abs
                        
                        # Apply OneEuroFilter (if smoothing enabled)
                        if self.smoothing_mode != 'off':
                            if self.filter_rx is None:
                                self.filter_rx = OneEuroFilter(timestamp_sec, rcx_abs, 
                                                               min_cutoff=self.min_cutoff, beta=self.beta)
                                self.filter_ry = OneEuroFilter(timestamp_sec, rcy_abs, 
                                                               min_cutoff=self.min_cutoff, beta=self.beta)
                            
                            rcx_abs = self.filter_rx(timestamp_sec, rcx_abs)
                            rcy_abs = self.filter_ry(timestamp_sec, rcy_abs)
                        # else: smoothing off, rcx_abs stays as raw value

                        frame_data['right_center_x'] = rcx_abs
                        frame_data['right_center_y'] = rcy_abs
                        frame_data['right_confidence'] = float(conf_used)
                        frame_data['right_method'] = method
                        
                        # Always store raw values in frame_data for analysis
                        frame_data['right_center_x_raw'] = float(rcx_raw)
                        frame_data['right_center_y_raw'] = float(rcy_raw)

                        # Draw final right iris center (yellow - smoothed)
                        cv2.circle(frame, (int(round(rcx_abs)), int(round(rcy_abs))),
                                   5, VIS_COLORS['mid'], -1)
                        
                        # Draw RAW right iris center (red crosshair) if debug overlay enabled
                        if self.show_raw_overlay:
                            # Draw small crosshair for raw position
                            rx, ry = int(round(rcx_raw)), int(round(rcy_raw))
                            crosshair_size = 6
                            cv2.line(frame, (rx - crosshair_size, ry), (rx + crosshair_size, ry), (0, 0, 255), 1)
                            cv2.line(frame, (rx, ry - crosshair_size), (rx, ry + crosshair_size), (0, 0, 255), 1)
                            cv2.circle(frame, (rx, ry), 2, (0, 0, 255), 1)  # Small circle at center

                        # Draw and store extrema if available
                        if x_min is not None:
                            left_x_abs = rx0 + x_min
                            right_x_abs = rx0 + x_max
                            left_y_abs = rcy_abs
                            right_y_abs = rcy_abs
                            cv2.circle(frame, (int(round(left_x_abs)), int(round(left_y_abs))),
                                       3, VIS_COLORS['extreme_lr'], -1)
                            cv2.circle(frame, (int(round(right_x_abs)), int(round(right_y_abs))),
                                       3, VIS_COLORS['extreme_lr'], -1)
                            frame_data['right_lr_left_x'] = float(left_x_abs)
                            frame_data['right_lr_left_y'] = float(left_y_abs)
                            frame_data['right_lr_right_x'] = float(right_x_abs)
                            frame_data['right_lr_right_y'] = float(right_y_abs)

                        if y_min is not None:
                            top_y_abs = ry0 + y_min
                            bottom_y_abs = ry0 + y_max
                            top_x_abs = rcx_abs
                            bottom_x_abs = rcx_abs
                            cv2.circle(frame, (int(round(top_x_abs)), int(round(top_y_abs))),
                                       3, VIS_COLORS['extreme_tb'], -1)
                            cv2.circle(frame, (int(round(bottom_x_abs)), int(round(bottom_y_abs))),
                                       3, VIS_COLORS['extreme_tb'], -1)
                            frame_data['right_tb_top_x'] = float(top_x_abs)
                            frame_data['right_tb_top_y'] = float(top_y_abs)
                            frame_data['right_tb_bottom_x'] = float(bottom_x_abs)
                            frame_data['right_tb_bottom_y'] = float(bottom_y_abs)
                    else:
                        frame_data['right_center_x'] = float(rcx_mp)
                        frame_data['right_center_y'] = float(rcy_mp)
                        frame_data['right_confidence'] = 0.2
                        frame_data['right_method'] = 'iris_landmark_center'
                        self.last_right_center = (rcx_mp, rcy_mp)
                        
                        if self.filter_rx is None:
                            self.filter_rx = OneEuroFilter(timestamp_sec, rcx_mp, min_cutoff=ONE_EURO_MIN_CUTOFF, beta=ONE_EURO_BETA)
                            self.filter_ry = OneEuroFilter(timestamp_sec, rcy_mp, min_cutoff=ONE_EURO_MIN_CUTOFF, beta=ONE_EURO_BETA)
                        
                        smoothed_x = self.filter_rx(timestamp_sec, rcx_mp)
                        smoothed_y = self.filter_ry(timestamp_sec, rcy_mp)
                        frame_data['right_center_x'] = smoothed_x
                        frame_data['right_center_y'] = smoothed_y
                        
                        cv2.circle(frame, (int(round(smoothed_x)), int(round(smoothed_y))), 5, VIS_COLORS['mid'], -1)

                    # Compute right iris diameter (in full-frame pixels)
                    right_diam = float('nan')

                    # Prefer horizontal distance between LR extrema if available
                    if (
                        'right_lr_left_x' in frame_data and 'right_lr_right_x' in frame_data and
                        not np.isnan(frame_data['right_lr_left_x']) and
                        not np.isnan(frame_data['right_lr_right_x'])
                    ):
                        right_diam = frame_data['right_lr_right_x'] - frame_data['right_lr_left_x']

                    # Otherwise, try vertical distance between TB extrema
                    if np.isnan(right_diam) and (
                        'right_tb_top_y' in frame_data and 'right_tb_bottom_y' in frame_data and
                        not np.isnan(frame_data['right_tb_top_y']) and
                        not np.isnan(frame_data['right_tb_bottom_y'])
                    ):
                        right_diam = frame_data['right_tb_bottom_y'] - frame_data['right_tb_top_y']

                    # Fallback: use MediaPipe iris radius rr if still NaN
                    if np.isnan(right_diam):
                        right_diam = 2.0 * rr  # rr is the iris radius from iris_center_radius

                    frame_data['right_iris_diameter'] = float(right_diam)


                    # Per-frame gaze (smoothed or raw depending on mode)
                    frame_data['gaze_x'] = (frame_data['left_center_x'] + frame_data['right_center_x']) / 2.0
                    frame_data['gaze_y'] = (frame_data['left_center_y'] + frame_data['right_center_y']) / 2.0
                    
                    # Raw gaze (always computed from raw eye coordinates if available)
                    if 'left_center_x_raw' in frame_data and 'right_center_x_raw' in frame_data:
                        frame_data['gaze_x_raw'] = (frame_data['left_center_x_raw'] + frame_data['right_center_x_raw']) / 2.0
                        frame_data['gaze_y_raw'] = (frame_data['left_center_y_raw'] + frame_data['right_center_y_raw']) / 2.0

            else:
                head_result = head_positioner.assess(None)
                cv2.putText(frame, "NO FACE", (self.width // 2 - 80, self.height // 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)

            if head_result:
                frame_data['head_status'] = head_result.get('status')
                frame_data['head_progress'] = head_result.get('progress')

            # Add zero-based coordinates that start from (0,0) at first valid sample.
            # This is additive: existing absolute coordinates are unchanged.
            self._set_zero_based_pair(
                frame_data,
                "left_center_x",
                "left_center_y",
                "left_center_x_from_start",
                "left_center_y_from_start",
                "left",
            )
            self._set_zero_based_pair(
                frame_data,
                "right_center_x",
                "right_center_y",
                "right_center_x_from_start",
                "right_center_y_from_start",
                "right",
            )
            self._set_zero_based_pair(
                frame_data,
                "gaze_x",
                "gaze_y",
                "gaze_x_from_start",
                "gaze_y_from_start",
                "gaze",
            )
            self._set_zero_based_pair(
                frame_data,
                "left_center_x_raw",
                "left_center_y_raw",
                "left_center_x_raw_from_start",
                "left_center_y_raw_from_start",
                "left_raw",
            )
            self._set_zero_based_pair(
                frame_data,
                "right_center_x_raw",
                "right_center_y_raw",
                "right_center_x_raw_from_start",
                "right_center_y_raw_from_start",
                "right_raw",
            )
            self._set_zero_based_pair(
                frame_data,
                "gaze_x_raw",
                "gaze_y_raw",
                "gaze_x_raw_from_start",
                "gaze_y_raw_from_start",
                "gaze_raw",
            )

            draw_overlay(frame, frame_data, self.total_frames)

            video_writer.write(frame)
            self.tracking_data.append(frame_data)

        self.cap.release()
        video_writer.release()

        self.detector_stats = {
            'ellipse_used_left': int(use_ellipse_L),
            'ellipse_used_right': int(use_ellipse_R),
        }

        print(f"\n✓ Tracked video: {output_video_path}")
        self._save_tracking_data()
        self._generate_summary()
        self._auto_generate_calibration()
        return self.tracking_data

    def _save_tracking_data(self):
        """
        Saves tracking data to CSV and JSON files in the output directory.
        """
        self._apply_slide_marks()
        df = pd.DataFrame(self.tracking_data)
        csv_path = self.output_dir / f"{self.video_path.stem}_tracking_data.csv"
        df.to_csv(csv_path, index=False)
        print(f"✓ CSV: {csv_path}")

        json_path = self.output_dir / f"{self.video_path.stem}_tracking_data.json"
        json_frames = []
        for frame in self.tracking_data:
            cleaned = {}
            for key, value in frame.items():
                if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                    cleaned[key] = None
                else:
                    cleaned[key] = value
            json_frames.append(cleaned)
        with open(json_path, 'w') as f:
            payload = {
                'frames': json_frames,
                'detector_stats': getattr(self, 'detector_stats', {})
            }
            json.dump(payload, f, indent=2)
        print(f"✓ JSON: {json_path}")

    def _apply_slide_marks(self):
        marks_path = self.output_dir / "slide_marks.json"
        if not marks_path.exists():
            marks_path = self.output_dir.parent / "slide_marks.json"
            if not marks_path.exists():
                return
        try:
            with open(marks_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception as exc:
            print(f"[WARN] Failed to read slide_marks.json: {exc}")
            return

        marks = payload.get("marks", [])
        normalized = []
        for mark in marks:
            filename = mark.get("filename")
            if not filename:
                continue
            if mark.get("t_ms") is not None:
                try:
                    t_sec = float(mark["t_ms"]) / 1000.0
                except (TypeError, ValueError):
                    continue
            elif mark.get("t_sec") is not None:
                try:
                    t_sec = float(mark["t_sec"])
                except (TypeError, ValueError):
                    continue
            else:
                continue
            normalized.append({
                "t_sec": t_sec,
                "filename": filename,
                "protocol_key": mark.get("protocol_key"),
                "slide_index": mark.get("slide_index"),
            })

        if not normalized:
            return

        normalized.sort(key=lambda item: item["t_sec"])
        idx = 0
        first_t = normalized[0]["t_sec"]
        for frame in self.tracking_data:
            ts = frame.get("timestamp_sec")
            if ts is None:
                continue
            while idx + 1 < len(normalized) and normalized[idx + 1]["t_sec"] <= ts:
                idx += 1
            if ts >= first_t:
                current = normalized[idx]
                frame["filename"] = current["filename"]
                if current.get("protocol_key") is not None:
                    frame["protocol_key"] = current["protocol_key"]
                if current.get("slide_index") is not None:
                    frame["slide_index"] = current["slide_index"]

    def _generate_summary(self):
        """
        Prints a summary of the tracking results to the console.
        """
        df = pd.DataFrame(self.tracking_data)
        valid_df = df[df['face_detected'] == True]
        if len(valid_df) > 0:
            left_counts = valid_df['left_method'].astype(str).value_counts()
            right_counts = valid_df['right_method'].astype(str).value_counts()

            def _get_percent(df, substring):
                matches = df.astype(str).str.contains(substring).sum()
                return matches, matches / len(df) * 100

            l_ell_n, l_ell_pct = _get_percent(valid_df['left_method'], 'ellipse')
            l_cir_n, l_cir_pct = _get_percent(valid_df['left_method'], 'circle')
            l_mp_n, l_mp_pct = _get_percent(valid_df['left_method'], 'landmark')
            l_blink_n, l_blink_pct = _get_percent(valid_df['left_method'], 'blink')
            
            r_ell_n, r_ell_pct = _get_percent(valid_df['right_method'], 'ellipse')
            r_cir_n, r_cir_pct = _get_percent(valid_df['right_method'], 'circle')
            r_mp_n, r_mp_pct = _get_percent(valid_df['right_method'], 'landmark')
            r_blink_n, r_blink_pct = _get_percent(valid_df['right_method'], 'blink')

            print(f"\n{'=' * 70}")
            print("SUMMARY (Per-frame)")
            print(f"{'=' * 70}")
            print(f"Face Detected: {len(valid_df)}/{len(df)} frames ({len(valid_df) / len(df) * 100:.1f}%)")
            print("-" * 30)
            print("LEFT EYE Methods:")
            print(f"  Ellipse:  {l_ell_n:>3} ({l_ell_pct:>5.1f}%)")
            print(f"  Circle:   {l_cir_n:>3} ({l_cir_pct:>5.1f}%)")
            print(f"  Fallback: {l_mp_n:>3} ({l_mp_pct:>5.1f}%)")
            print(f"  Blink:    {l_blink_n:>3} ({l_blink_pct:>5.1f}%)")
            print("-" * 30)
            print("RIGHT EYE Methods:")
            print(f"  Ellipse:  {r_ell_n:>3} ({r_ell_pct:>5.1f}%)")
            print(f"  Circle:   {r_cir_n:>3} ({r_cir_pct:>5.1f}%)")
            print(f"  Fallback: {r_mp_n:>3} ({r_mp_pct:>5.1f}%)")
            print(f"  Blink:    {r_blink_n:>3} ({r_blink_pct:>5.1f}%)")
            print(f"{'=' * 70}\n")

    def _auto_generate_calibration(self):
        """
        Automatically generates calibration files if calibration_targets.json exists.
        This runs after tracking data is saved.
        """
        # Check for calibration_targets.json in parent directory (session root)
        targets_path = self.output_dir.parent / "calibration_targets.json"
        if not targets_path.exists():
            # Also check in output_dir itself
            targets_path = self.output_dir / "calibration_targets.json"
            if not targets_path.exists():
                return  # No calibration targets, skip

        print("\n" + "=" * 70)
        print("AUTO-GENERATING CALIBRATION")
        print("=" * 70)

        # Find the calibration_fit.py script
        script_dir = Path(__file__).parent
        calibration_script = script_dir / "calibration_fit.py"

        if not calibration_script.exists():
            print(f"[WARN] Calibration script not found at {calibration_script}")
            return

        # Run calibration_fit.py with the session directory (parent of output_dir)
        session_dir = self.output_dir.parent

        try:
            result = subprocess.run(
                [sys.executable, str(calibration_script), str(session_dir)],
                cwd=str(script_dir.parent),  # Run from project root
                capture_output=True,
                text=True,
                timeout=60  # 60 second timeout
            )

            if result.returncode == 0:
                print("✓ Calibration generated successfully")
                if result.stdout:
                    print(result.stdout)
            else:
                print(f"[ERROR] Calibration failed with exit code {result.returncode}")
                if result.stderr:
                    print("Error output:")
                    print(result.stderr)
        except subprocess.TimeoutExpired:
            print("[ERROR] Calibration generation timed out after 60 seconds")
        except Exception as e:
            print(f"[ERROR] Failed to run calibration: {e}")


def parse_args():
    """
    Parses command-line arguments.
    """
    parser = argparse.ArgumentParser(description="Eye tracking recorder/analyzer")
    parser.add_argument("--no-preview", action="store_true", help="Disable the OpenCV preview window")
    parser.add_argument("--output-dir", type=str, default=None, help="Custom output directory for recordings")
    parser.add_argument("--video", type=str, default=None, help="Analyze an existing video file instead of recording")
    parser.add_argument("--show-raw-overlay", action="store_true", help="Show raw (unsmoothed) iris centers in overlay (debug)")
    parser.add_argument("--smoothing", type=str, choices=['off', 'light', 'medium', 'heavy'],
                       default=DEFAULT_SMOOTHING_MODE, help="Smoothing preset (default: light)")
    parser.add_argument("--min-cutoff", type=float, default=None, help="Override min_cutoff (Hz) for OneEuroFilter")
    parser.add_argument("--beta", type=float, default=None, help="Override beta for OneEuroFilter")
    return parser.parse_args()


def main():
    """
    Main entry point of the script.
    1. Records video from webcam.
    2. Runs analysis on the recorded video.
    """
    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)
    args = parse_args()
    show_preview = not args.no_preview
    output_dir = args.output_dir if args.output_dir else "recordings"
    # Use module default if CLI flag not explicitly provided
    show_raw = args.show_raw_overlay if args.show_raw_overlay else SHOW_RAW_OVERLAY

    print("\n" + "=" * 70)
    print("EYE TRACKING - RECORD & ANALYZE (Improved Algorithm)")
    print("=" * 70)

    if args.video:
        use_video = args.video
        if not Path(use_video).exists():
            print(f"\n[WARN] Video file not found: {use_video}")
            return
        if args.output_dir:
            process_output_dir = Path(args.output_dir)
        else:
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            safe_stem = Path(use_video).stem.replace(" ", "_")
            process_output_dir = Path("recordings") / f"import_{safe_stem}_{stamp}"
        process_output_dir.mkdir(parents=True, exist_ok=True)
        print(f"[INFO] Using existing video: {use_video}")
        print(f"[INFO] Output directory: {process_output_dir}")
    else:
        try:
            video_path, fps = record_video(
                CAM_INDEX,
                output_dir=output_dir,
                show_preview=show_preview,
                stop_check=lambda: stop_requested,
            )
            use_video = video_path
        except Exception as e:
            print(f"\n[WARN] {e}")
            return
        process_output_dir = Path(use_video).parent

    try:
        tracker = EyeTracker(
            use_video, 
            output_dir=str(process_output_dir), 
            show_raw_overlay=show_raw,
            smoothing_mode=args.smoothing,
            min_cutoff=args.min_cutoff,
            beta=args.beta
        )
        tracker.process_video()
        print(f"[OK] DONE. Check '{process_output_dir}/' folder.\n")
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
