# tracker/main.py
import os
import argparse
import signal

os.environ.setdefault("OPENCV_VIDEOIO_PRIORITY_MSMF", "0")

import cv2
import numpy as np
import pandas as pd
from pathlib import Path
import mediapipe as mp
from tqdm import tqdm
import json
from datetime import datetime
import shutil
import sys

stop_requested = False


def _handle_stop(signum, _frame):
    global stop_requested
    stop_requested = True
    print(f"\n[INFO] Received signal {signum}; stopping recording…")

# --------- Configuration ----------
CAM_INDEX = 0

# Processing params
CLAHE_CLIP_LIMIT = 3.0
CLAHE_GRID_SIZE = (8, 8)

CANNY_LO = 30
CANNY_HI = 90
ADAPT_BLOCK = 21
ADAPT_C = 3

# Glint suppression
GLINT_PERCENTILE = 99.0  # top 1% brightest pixels
GLINT_INPAINT_RADIUS = 2
USE_HSV_GLINT = True  # HSV-based specular mask before inpaint

# ROI
EYE_PAD = 15  # fallback
DYN_ROI_SCALE = 3.0  # ROI side ≈ k * iris radius (pixels)

# Ring selection around iris (for edge points)
RING_INNER_FRAC = 0.85  # inner bound of ring, relative to iris radius
RING_OUTER_FRAC = 1.15  # outer bound of ring, relative to iris radius

# Confidence threshold for "hold last good value"
MIN_CONF = 0.4

# Eye landmarks (MediaPipe FaceMesh indices)
LEFT_EYE_IDX = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173]
RIGHT_EYE_IDX = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]

# Iris landmark sets (with refine_landmarks=True)
LEFT_IRIS_IDX = [468, 469, 470, 471, 472]
RIGHT_IRIS_IDX = [473, 474, 475, 476, 477]

# Visualization colors
VIS_COLORS = {
    'left_dot': (0, 0, 255),
    'right_dot': (255, 0, 0),
    'mid': (0, 255, 255),  # final iris center / gaze
    'text': (255, 255, 255),
    'rough': (0, 255, 0),  # rough MP iris center
    'extreme_lr': (0, 165, 255),  # left/right extrema (orange)
    'extreme_tb': (255, 0, 255),  # top/bottom extrema (magenta)
    'roi_box': (0, 255, 0),  # ROI rectangle
}


# ---------- Utilities ----------
def clear_output_dir(path="output"):
    out = Path(path)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)


def _open_cam(index: int):
    if sys.platform.startswith("win"):
        return cv2.VideoCapture(index, cv2.CAP_DSHOW)
    return cv2.VideoCapture(index)


def _find_working_camera(preferred: int, search_range=6):
    cap = _open_cam(preferred)
    if cap.isOpened():
        return cap, preferred
    cap.release()
    for i in range(search_range):
        if i == preferred:
            continue
        test = _open_cam(i)
        if test.isOpened():
            return test, i
        test.release()
    return None, None


def _try_lock_camera_props(cap):
    # Best-effort: stabilizes exposure/focus without adding temporal lag.
    try:
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_EXPOSURE, -6)
    except Exception:
        pass
    try:
        cap.set(cv2.CAP_PROP_AUTO_WB, 0)
        cap.set(cv2.CAP_PROP_WB_TEMPERATURE, 4600)
    except Exception:
        pass
    try:
        cap.set(cv2.CAP_PROP_FOCUS, 0)
    except Exception:
        pass


def record_video(output_dir="recordings", show_preview=True):
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    video_filename = output_path / f"recording_{timestamp}.mp4"

    cap, used_idx = _find_working_camera(CAM_INDEX)
    if cap is None:
        raise RuntimeError(f"Camera not available at index {CAM_INDEX} (and no alternatives found).")

    _try_lock_camera_props(cap)

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps == 0 or fps > 120:
        fps = 30.0

    print(f"\n{'=' * 70}")
    print("CAMERA RECORDING")
    print(f"{'=' * 70}")
    print(f"Using camera index: {used_idx}")
    print(f"Resolution: {width}x{height}")
    print(f"FPS: {fps}")
    if show_preview:
        print(f"\nPress 'Q' to stop recording")
        print(f"{'=' * 70}\n")

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(str(video_filename), fourcc, fps, (width, height))

    frame_count = 0
    global stop_requested
    stop_requested = False

    while True:
        ok, frame = cap.read()
        if not ok:
            continue

        out.write(frame)

        if show_preview:
            display = frame.copy()
            cv2.circle(display, (20, 20), 8, (0, 0, 255), -1)
            cv2.putText(display, "REC", (35, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            cv2.putText(display, f"Time: {frame_count / fps:.1f}s", (20, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
            cv2.putText(display, "Press 'Q' to quit", (20, height - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
            cv2.imshow("Recording - Press Q to Stop", display)

        frame_count += 1
        if show_preview and cv2.waitKey(1) & 0xFF == ord('q'):
            stop_requested = True

        if stop_requested:
            break

    cap.release()
    out.release()
    if show_preview:
        cv2.destroyAllWindows()

    print(f"\n[OK] Recording complete ({frame_count} frames)\n")
    return str(video_filename), fps


def get_eye_roi(landmarks, eye_indices, w, h, padding=EYE_PAD):
    pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in eye_indices], dtype=np.float32)
    x0, y0 = np.floor(pts.min(axis=0) - padding).astype(int)
    x1, y1 = np.ceil(pts.max(axis=0) + padding).astype(int)
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


def get_eye_roi_dynamic(w, h, iris_center, iris_radius, k=DYN_ROI_SCALE):
    cx, cy = iris_center
    s = int(round(k * max(12, iris_radius)))
    x0, y0 = int(cx - s), int(cy - s)
    x1, y1 = int(cx + s), int(cy + s)
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


def iris_center_radius(landmarks, iris_indices, w, h):
    pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in iris_indices], dtype=np.float32)
    cx, cy = pts.mean(axis=0)
    r = np.mean(np.linalg.norm(pts - np.array([cx, cy], dtype=np.float32), axis=1))
    return float(cx), float(cy), float(r)


# ---------- Glint suppression ----------
def suppress_glints(gray):
    p = np.percentile(gray, GLINT_PERCENTILE)
    _, mask = cv2.threshold(gray, int(p), 255, cv2.THRESH_BINARY)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros_like(mask)
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        if 1 <= area <= 200:
            keep[labels == i] = 255
    if np.any(keep):
        return cv2.inpaint(gray, keep, GLINT_INPAINT_RADIUS, cv2.INPAINT_TELEA)
    return gray


def suppress_glints_hsv(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    H, S, V = cv2.split(hsv)
    vthr = np.percentile(V, 98)
    mask = ((V > vthr) & (S < 60)).astype(np.uint8) * 255
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if mask.any():
        return cv2.inpaint(gray, mask, GLINT_INPAINT_RADIUS, cv2.INPAINT_TELEA)
    return gray


def preprocess_eye(roi_bgr):
    if USE_HSV_GLINT:
        gray = suppress_glints_hsv(roi_bgr)
    else:
        gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
        gray = suppress_glints(gray)
    clahe = cv2.createCLAHE(clipLimit=CLAHE_CLIP_LIMIT, tileGridSize=CLAHE_GRID_SIZE)
    gray = clahe.apply(gray)
    return gray


# ---------- Extrema-based refinement ----------
def refine_center_with_extrema(pts, approx_center, min_span_px=4):
    if pts is None or len(pts) < 10:
        return None

    ys = pts[:, 0].astype(np.float32)
    xs = pts[:, 1].astype(np.float32)

    x_min = xs.min()
    x_max = xs.max()
    y_min = ys.min()
    y_max = ys.max()

    span_x = x_max - x_min
    span_y = y_max - y_min

    if span_x < min_span_px:
        return None

    cx_h = 0.5 * (x_min + x_max)

    if span_y >= min_span_px:
        cy_v = 0.5 * (y_min + y_max)
    else:
        cy_v = approx_center[1]

    return float(cx_h), float(cy_v), float(x_min), float(x_max), float(y_min), float(y_max)


# ---------- Exact per-frame iris center: ellipse fit ----------
def iris_center_ellipse(roi_bgr, approx_center_roi, approx_radius_roi):
    h, w = roi_bgr.shape[:2]
    if min(h, w) < 12:
        return None

    gray = preprocess_eye(roi_bgr)
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, ADAPT_BLOCK, ADAPT_C)
    edges = cv2.Canny(gray, CANNY_LO, CANNY_HI)

    Y, X = np.indices((h, w))
    r = np.sqrt((X - approx_center_roi[0]) ** 2 + (Y - approx_center_roi[1]) ** 2)
    ring = (r > RING_INNER_FRAC * approx_radius_roi) & (r < RING_OUTER_FRAC * approx_radius_roi)

    pts = np.column_stack(np.where((edges > 0) & (dark > 0) & ring))
    if len(pts) < 20:
        return None

    if len(pts) > 1000:
        idx = np.random.choice(len(pts), 1000, replace=False)
        pts = pts[idx]

    pts_xy = pts[:, ::-1].astype(np.float32)
    try:
        ellipse = cv2.fitEllipse(pts_xy)
        (cx_init, cy_init), (MA, ma), angle = ellipse
        circ = min(MA, ma) / max(MA, ma + 1e-6)
        ok_size = 5 <= min(MA, ma) <= 150
        if not ok_size:
            return None

        t = np.linspace(0, 2 * np.pi, 64, endpoint=False)
        a, b = MA / 2.0, ma / 2.0
        cosA, sinA = np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))
        xs_samp = cx_init + a * np.cos(t) * cosA - b * np.sin(t) * sinA
        ys_samp = cy_init + a * np.cos(t) * sinA + b * np.sin(t) * cosA
        xs_samp = np.clip(xs_samp.astype(int), 0, w - 1)
        ys_samp = np.clip(ys_samp.astype(int), 0, h - 1)
        perim_hits = (edges[ys_samp, xs_samp] > 0).sum()
        inlier_frac = perim_hits / 64.0

        ext = refine_center_with_extrema(pts, approx_center_roi)
        if ext is not None:
            cx, cy, x_min, x_max, y_min, y_max = ext
        else:
            cx, cy = cx_init, cy_init
            x_min = x_max = y_min = y_max = None

        ellipse_refined = ((float(cx), float(cy)), (MA, ma), angle)

        conf = float(np.clip(0.5 * inlier_frac + 0.5 * circ, 0.0, 1.0))
        return (float(cx), float(cy), conf, ellipse_refined, float(circ), int(len(pts)),
                x_min, x_max, y_min, y_max)
    except:
        return None


# ---------- Exact per-frame iris center: Taubin circle fit ----------
def _taubin_circle_fit(x, y):
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if x.size < 3:
        return None
    x_m = x.mean()
    y_m = y.mean()
    u = x - x_m
    v = y - y_m

    Suu = np.sum(u * u)
    Suv = np.sum(u * v)
    Svv = np.sum(v * v)
    Suuu = np.sum(u * u * u)
    Svvv = np.sum(v * v * v)
    Suvv = np.sum(u * v * v)
    Svuu = np.sum(v * u * u)

    A = np.array([[Suu, Suv],
                  [Suv, Svv]], dtype=np.float64)
    b = 0.5 * np.array([Suuu + Suvv, Svvv + Svuu], dtype=np.float64)

    det = A[0, 0] * A[1, 1] - A[0, 1] * A[1, 0]
    if abs(det) < 1e-12:
        return None

    uc, vc = np.linalg.solve(A, b)
    xc = x_m + uc
    yc = y_m + vc
    r = np.sqrt(uc * uc + vc * vc + (Suu + Svv) / x.size)
    return float(xc), float(yc), float(r)


def iris_center_circle(roi_bgr, approx_center_roi, approx_radius_roi):
    h, w = roi_bgr.shape[:2]
    if min(h, w) < 12:
        return None
    gray = preprocess_eye(roi_bgr)
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, ADAPT_BLOCK, ADAPT_C)
    edges = cv2.Canny(gray, CANNY_LO, CANNY_HI)

    Y, X = np.indices((h, w))
    r = np.sqrt((X - approx_center_roi[0]) ** 2 + (Y - approx_center_roi[1]) ** 2)
    ring = (r > RING_INNER_FRAC * approx_radius_roi) & (r < RING_OUTER_FRAC * approx_radius_roi)

    pts = np.column_stack(np.where((edges > 0) & (dark > 0) & ring))
    if len(pts) < 8:
        return None

    if len(pts) > 1200:
        idx = np.random.choice(len(pts), 1200, replace=False)
        pts = pts[idx]

    xs = pts[:, 1].astype(np.float64)
    ys = pts[:, 0].astype(np.float64)
    fit = _taubin_circle_fit(xs, ys)
    if fit is None:
        return None
    cx_init, cy_init, rad = fit

    ext = refine_center_with_extrema(pts, approx_center_roi)
    if ext is not None:
        cx, cy, x_min, x_max, y_min, y_max = ext
    else:
        cx, cy = cx_init, cy_init
        x_min = x_max = y_min = y_max = None

    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    resid = np.abs(d - rad)
    thr = max(1.5, 0.08 * rad)
    inlier_frac = float((resid < thr).mean())
    conf = float(np.clip(inlier_frac, 0.0, 1.0))
    return (float(cx), float(cy), conf, float(rad), int(len(pts)),
            x_min, x_max, y_min, y_max)


def compute_midpoint(p1, p2):
    return ((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5)


# -------------- Recorder / Processor --------------
class EyeTracker:
    def __init__(self, video_path, output_dir="output"):
        self.video_path = Path(video_path)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

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

        print(f"\n{'=' * 70}")
        print(f"VIDEO PROCESSING")
        print(f"{'=' * 70}")
        print(f"Resolution: {self.width}x{self.height}")
        print(f"FPS: {self.fps:.2f}")
        print(f"Total Frames: {self.total_frames}")
        print(f"Duration: {self.duration_sec:.2f}s")
        print(f"{'=' * 70}\n")

    def process_video(self):
        mp_face_mesh = mp.solutions.face_mesh
        face_mesh = mp_face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )

        output_video_path = self.output_dir / f"{self.video_path.stem}_tracked.mp4"
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        video_writer = cv2.VideoWriter(str(output_video_path), fourcc, self.fps, (self.width, self.height))

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

            if result and result.multi_face_landmarks:
                lms = result.multi_face_landmarks[0].landmark
                frame_data['face_detected'] = True

                lcx_mp, lcy_mp, lr = iris_center_radius(lms, LEFT_IRIS_IDX, self.width, self.height)
                rcx_mp, rcy_mp, rr = iris_center_radius(lms, RIGHT_IRIS_IDX, self.width, self.height)

                frame_data['left_mp_x'] = lcx_mp
                frame_data['left_mp_y'] = lcy_mp
                frame_data['right_mp_x'] = rcx_mp
                frame_data['right_mp_y'] = rcy_mp

                cv2.circle(frame, (int(round(lcx_mp)), int(round(lcy_mp))), 3, VIS_COLORS['rough'], 1)
                cv2.circle(frame, (int(round(rcx_mp)), int(round(rcy_mp))), 3, VIS_COLORS['rough'], 1)

                lx0, ly0, lx1, ly1 = get_eye_roi_dynamic(self.width, self.height, (lcx_mp, lcy_mp), lr)
                rx0, ry0, rx1, ry1 = get_eye_roi_dynamic(self.width, self.height, (rcx_mp, rcy_mp), rr)
                left_roi = frame[ly0:ly1, lx0:lx1]
                right_roi = frame[ry0:ry1, rx0:rx1]

                cv2.rectangle(frame, (lx0, ly0), (lx1, ly1), VIS_COLORS['roi_box'], 1)
                cv2.rectangle(frame, (rx0, ry0), (rx1, ry1), VIS_COLORS['roi_box'], 1)

                # LEFT EYE
                l_ell = iris_center_ellipse(left_roi, (lcx_mp - lx0, lcy_mp - ly0), lr)
                l_cir = iris_center_circle(left_roi, (lcx_mp - lx0, lcy_mp - ly0), lr)

                bestL = None
                if l_ell and l_cir:
                    conf_ell = l_ell[2] * (0.9 + 0.1 * l_ell[4])
                    conf_cir = l_cir[2]
                    bestL = ('ellipse', l_ell) if conf_ell >= conf_cir else ('circle', l_cir)
                elif l_ell:
                    bestL = ('ellipse', l_ell)
                elif l_cir:
                    bestL = ('circle', l_cir)

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
                        lcx_abs, lcy_abs = self.last_left_center
                        method = method_base + "_held(prev)"
                        conf_used = conf
                    else:
                        self.last_left_center = (lcx_abs, lcy_abs)
                        method = method_base
                        conf_used = conf

                    frame_data['left_center_x'] = lcx_abs
                    frame_data['left_center_y'] = lcy_abs
                    frame_data['left_confidence'] = float(conf_used)
                    frame_data['left_method'] = method

                    cv2.circle(frame, (int(round(lcx_abs)), int(round(lcy_abs))),
                               5, VIS_COLORS['mid'], -1)
                else:
                    frame_data['left_center_x'] = float(lcx_mp)
                    frame_data['left_center_y'] = float(lcy_mp)
                    frame_data['left_confidence'] = 0.2
                    frame_data['left_method'] = 'iris_landmark_center'
                    self.last_left_center = (lcx_mp, lcy_mp)
                    cv2.circle(frame, (int(round(lcx_mp)), int(round(lcy_mp))), 5, VIS_COLORS['mid'], -1)

                # RIGHT EYE
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

                    frame_data['right_center_x'] = rcx_abs
                    frame_data['right_center_y'] = rcy_abs
                    frame_data['right_confidence'] = float(conf_used)
                    frame_data['right_method'] = method

                    cv2.circle(frame, (int(round(rcx_abs)), int(round(rcy_abs))),
                               5, VIS_COLORS['mid'], -1)
                else:
                    frame_data['right_center_x'] = float(rcx_mp)
                    frame_data['right_center_y'] = float(rcy_mp)
                    frame_data['right_confidence'] = 0.2
                    frame_data['right_method'] = 'iris_landmark_center'
                    self.last_right_center = (rcx_mp, rcy_mp)
                    cv2.circle(frame, (int(round(rcx_mp)), int(round(rcy_mp))), 5, VIS_COLORS['mid'], -1)

                frame_data['gaze_x'] = (frame_data['left_center_x'] + frame_data['right_center_x']) / 2.0
                frame_data['gaze_y'] = (frame_data['left_center_y'] + frame_data['right_center_y']) / 2.0

                self._draw_overlay(frame, frame_data)

            else:
                cv2.putText(frame, "NO FACE", (self.width // 2 - 80, self.height // 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 255), 3)

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
        return self.tracking_data

    def _draw_overlay(self, frame, data):
        overlay = frame.copy()
        cv2.rectangle(overlay, (5, 5), (650, 140), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.7, frame, 0.3, 0, frame)

        y = 25
        cv2.putText(frame, f"Frame: {data['frame']}/{self.total_frames}",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, VIS_COLORS['text'], 1)
        y += 25
        cv2.putText(frame, f"Time: {data['time_formatted']}",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, VIS_COLORS['text'], 1)
        y += 25

        if 'left_center_x' in data:
            cv2.putText(frame,
                        f"L: ({int(data['left_center_x'])},{int(data['left_center_y'])}) "
                        f"conf {data['left_confidence']:.2f}",
                        (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['left_dot'], 1)
        y += 25
        if 'right_center_x' in data:
            cv2.putText(frame,
                        f"R: ({int(data['right_center_x'])},{int(data['right_center_y'])}) "
                        f"conf {data['right_confidence']:.2f}",
                        (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['right_dot'], 1)
        y += 25
        if 'gaze_x' in data:
            cv2.putText(frame, f"Gaze: ({int(data['gaze_x'])},{int(data['gaze_y'])})",
                        (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['mid'], 1)

    def _save_tracking_data(self):
        df = pd.DataFrame(self.tracking_data)
        csv_path = self.output_dir / f"{self.video_path.stem}_tracking_data.csv"
        df.to_csv(csv_path, index=False)
        print(f"✓ CSV: {csv_path}")

        json_path = self.output_dir / f"{self.video_path.stem}_tracking_data.json"
        with open(json_path, 'w') as f:
            json.dump(self.tracking_data, f, indent=2)
        print(f"✓ JSON: {json_path}")

    def _generate_summary(self):
        df = pd.DataFrame(self.tracking_data)
        valid_df = df[df['face_detected'] == True]
        if len(valid_df) > 0:
            print(f"\n{'=' * 70}")
            print("SUMMARY")
            print(f"{'=' * 70}")
            print(f"Face Detected: {len(valid_df)}/{len(df)} frames ({len(valid_df) / len(df) * 100:.1f}%)")
            print(f"{'=' * 70}\n")


def parse_args():
    parser = argparse.ArgumentParser(description="Eye tracking recorder/analyzer")
    parser.add_argument("--no-preview", action="store_true", help="Disable the OpenCV preview window")
    parser.add_argument("--output-dir", type=str, default=None, help="Custom output directory for recordings")
    return parser.parse_args()


def main():
    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)
    args = parse_args()
    show_preview = not args.no_preview
    output_dir = args.output_dir if args.output_dir else "recordings"

    print("\n" + "=" * 70)
    print("EYE TRACKING - RECORD & ANALYZE (Improved Algorithm)")
    print("=" * 70)

    try:
        video_path, fps = record_video(output_dir=output_dir, show_preview=show_preview)
        use_video = video_path
    except Exception as e:
        print(f"\n[WARN] {e}")
        return

    process_output_dir = Path(use_video).parent

    try:
        tracker = EyeTracker(use_video, output_dir=str(process_output_dir))
        tracker.process_video()
        print(f"[OK] DONE. Check '{process_output_dir}/' folder.\n")
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
