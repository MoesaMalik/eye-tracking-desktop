# tracker/main.py
import os
# Prefer DirectShow over MSMF on Windows; MSMF often fails by index
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

def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default

CAM_INDEX = _env_int("CAM_INDEX", 0)

CLAHE_CLIP_LIMIT = 3.0
CLAHE_GRID_SIZE = (8, 8)
CANNY_LO = 30
CANNY_HI = 90
ADAPT_BLOCK = 21
ADAPT_C = 3
GLINT_PERCENTILE = 99.0
GLINT_INPAINT_RADIUS = 2
EYE_PAD = 15

LEFT_EYE_IDX = [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173]
RIGHT_EYE_IDX = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]
LEFT_IRIS_IDX = [468, 469, 470, 471, 472]
RIGHT_IRIS_IDX = [473, 474, 475, 476, 477]

VIS_COLORS = {
    'left_dot': (0, 0, 255),
    'right_dot': (255, 0, 0),
    'mid': (0, 255, 255),
    'text': (255, 255, 255),
}

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

def _find_sample_video():
    roots = [
        Path(__file__).parent / "sample.mp4",
        Path("tracker") / "sample.mp4",
        Path("assets") / "sample.mp4",
        Path("sample.mp4"),
    ]
    for p in roots:
        if p.exists():
            return str(p)
    return None

def record_video(output_dir="recordings"):
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    video_filename = output_path / f"recording_{timestamp}.mp4"

    cap, used_idx = _find_working_camera(CAM_INDEX)
    if cap is None:
        raise RuntimeError(f"Camera not available at index {CAM_INDEX} (and no alternatives found).")

    print(f"\n{'=' * 70}")
    print("CAMERA RECORDING")
    print(f"{'=' * 70}")
    print(f"Using camera index: {used_idx}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
    fps = cap.get(cv2.CAP_PROP_FPS)
    if fps == 0 or fps > 120:
        fps = 30.0
    print(f"Resolution: {width}x{height}")
    print(f"FPS: {fps}")
    print(f"\nPress 'Q' to stop recording")
    print(f"{'=' * 70}\n")

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(str(video_filename), fourcc, fps, (width, height))

    frame_count = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            continue
        out.write(frame)

        display = frame.copy()
        cv2.circle(display, (20, 20), 8, (0, 0, 255), -1)
        cv2.putText(display, "REC", (35, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        cv2.putText(display, f"Time: {frame_count / fps:.1f}s", (20, 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
        cv2.putText(display, "Press 'Q' to quit", (20, height - 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        cv2.imshow("Recording - Press Q to Stop", display)

        frame_count += 1
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    out.release()
    cv2.destroyAllWindows()

    print(f"\n[OK] Recording complete ({frame_count} frames)\n")
    return str(video_filename), fps

def get_eye_roi(landmarks, eye_indices, w, h, padding=EYE_PAD):
    pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in eye_indices], dtype=np.float32)
    x0, y0 = np.floor(pts.min(axis=0) - padding).astype(int)
    x1, y1 = np.ceil(pts.max(axis=0) + padding).astype(int)
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)

def iris_center_radius(landmarks, iris_indices, w, h):
    pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in iris_indices], dtype=np.float32)
    cx, cy = pts.mean(axis=0)
    r = np.mean(np.linalg.norm(pts - np.array([cx, cy], dtype=np.float32), axis=1))
    return float(cx), float(cy), float(r)

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

def preprocess_eye(roi_bgr):
    gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=CLAHE_CLIP_LIMIT, tileGridSize=CLAHE_GRID_SIZE)
    gray = clahe.apply(gray)
    gray = suppress_glints(gray)
    return gray

def find_iris_edges(roi_bgr, approx_center_roi, approx_radius_roi):
    h, w = roi_bgr.shape[:2]
    if h < 10 or w < 10:
        return None

    gray = preprocess_eye(roi_bgr)
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, ADAPT_BLOCK, ADAPT_C)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((3,3), np.uint8))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((3,3), np.uint8))

    edges = cv2.Canny(gray, CANNY_LO, CANNY_HI)
    band = np.zeros_like(edges)
    cy = int(round(approx_center_roi[1]))
    band_half = max(2, int(round(0.08 * max(1, approx_radius_roi))))
    y0 = max(0, cy - band_half)
    y1 = min(h - 1, cy + band_half)
    band[y0:y1+1, :] = 255

    mask = cv2.bitwise_and(edges, band)
    mask = cv2.bitwise_and(mask, dark)

    xs = np.where(mask > 0)[1]
    ys = np.where(mask > 0)[0]
    if len(xs) > 0:
        xmin = int(round(approx_center_roi[0] - 1.6 * approx_radius_roi))
        xmax = int(round(approx_center_roi[0] + 1.6 * approx_radius_roi))
        sel = (xs >= max(0, xmin)) & (xs <= min(w-1, xmax))
        xs_sel = xs[sel]
        ys_sel = ys[sel]
        if len(xs_sel) > 0:
            li = int(np.argmin(xs_sel))
            ri = int(np.argmax(xs_sel))
            lx, ly = float(xs_sel[li]), float(ys_sel[li])
            rx, ry = float(xs_sel[ri]), float(ys_sel[ri])
            density = min(1.0, len(xs_sel) / 80.0)
            return (lx, ly), (rx, ry), float(density)

    row = np.clip(cy, 1, h - 2)
    center_x = int(round(approx_center_roi[0]))
    thr = 14
    lx = None
    for x in range(center_x, max(1, center_x - int(2*approx_radius_roi)), -1):
        g = int(gray[row, x]) - int(gray[row, x-1])
        if g < -thr:
            lx = float(x)
            break
    rx = None
    for x in range(center_x, min(w - 2, center_x + int(2*approx_radius_roi))):
        g = int(gray[row, x+1]) - int(gray[row, x])
        if g > thr:
            rx = float(x+1)
            break
    if lx is not None and rx is not None and rx > lx:
        conf = 0.35
        return (lx, float(row)), (rx, float(row)), conf
    return None

def compute_midpoint(p1, p2):
    return ((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5)

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

        print(f"\n{'=' * 70}")
        print("VIDEO PROCESSING")
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

                lcx, lcy, lr = iris_center_radius(lms, LEFT_IRIS_IDX, self.width, self.height)
                rcx, rcy, rr = iris_center_radius(lms, RIGHT_IRIS_IDX, self.width, self.height)

                lx0, ly0, lx1, ly1 = get_eye_roi(lms, LEFT_EYE_IDX, self.width, self.height)
                left_roi = frame[ly0:ly1, lx0:lx1]
                l_center_roi = (lcx - lx0, lcy - ly0)
                left_edges = find_iris_edges(left_roi, l_center_roi, lr)

                rx0, ry0, rx1, ry1 = get_eye_roi(lms, RIGHT_EYE_IDX, self.width, self.height)
                right_roi = frame[ry0:ry1, rx0:rx1]
                r_center_roi = (rcx - rx0, rcy - ry0)
                right_edges = find_iris_edges(right_roi, r_center_roi, rr)

                if left_edges:
                    (llx, lly), (lrx, lry), lconf = left_edges
                    llx_abs, lly_abs = float(llx + lx0), float(lly + ly0)
                    lrx_abs, lry_abs = float(lrx + lx0), float(lry + ly0)
                    lcx_mid, lcy_mid = compute_midpoint((llx_abs, lly_abs), (lrx_abs, lry_abs))

                    frame_data['left_edge_L_x'] = llx_abs
                    frame_data['left_edge_L_y'] = lly_abs
                    frame_data['left_edge_R_x'] = lrx_abs
                    frame_data['left_edge_R_y'] = lry_abs
                    frame_data['left_center_x'] = lcx_mid
                    frame_data['left_center_y'] = lcy_mid
                    frame_data['left_confidence'] = float(lconf)
                    frame_data['left_method'] = 'edge_band'

                    cv2.circle(frame, (int(round(llx_abs)), int(round(lly_abs))), 4, (0, 255, 0), -1)
                    cv2.circle(frame, (int(round(lrx_abs)), int(round(lry_abs))), 4, (0, 255, 0), -1)
                    cv2.circle(frame, (int(round(lcx_mid)), int(round(lcy_mid))), 5, VIS_COLORS['mid'], -1)
                else:
                    frame_data['left_center_x'] = float(lcx)
                    frame_data['left_center_y'] = float(lcy)
                    frame_data['left_confidence'] = 0.0
                    frame_data['left_method'] = 'iris_landmark_center'
                    cv2.circle(frame, (int(round(lcx)), int(round(lcy))), 5, VIS_COLORS['mid'], -1)

                if right_edges:
                    (rlx, rly), (rrx, rry), rconf = right_edges
                    rlx_abs, rly_abs = float(rlx + rx0), float(rly + ry0)
                    rrx_abs, rry_abs = float(rrx + rx0), float(rry + ry0)
                    rcx_mid, rcy_mid = compute_midpoint((rlx_abs, rly_abs), (rrx_abs, rry_abs))

                    frame_data['right_edge_L_x'] = rlx_abs
                    frame_data['right_edge_L_y'] = rly_abs
                    frame_data['right_edge_R_x'] = rrx_abs
                    frame_data['right_edge_R_y'] = rry_abs
                    frame_data['right_center_x'] = rcx_mid
                    frame_data['right_center_y'] = rcy_mid
                    frame_data['right_confidence'] = float(rconf)
                    frame_data['right_method'] = 'edge_band'

                    cv2.circle(frame, (int(round(rlx_abs)), int(round(rly_abs))), 4, (0, 255, 0), -1)
                    cv2.circle(frame, (int(round(rrx_abs)), int(round(rry_abs))), 4, (0, 255, 0), -1)
                    cv2.circle(frame, (int(round(rcx_mid)), int(round(rcy_mid))), 5, VIS_COLORS['mid'], -1)
                else:
                    frame_data['right_center_x'] = float(rcx)
                    frame_data['right_center_y'] = float(rcy)
                    frame_data['right_confidence'] = 0.0
                    frame_data['right_method'] = 'iris_landmark_center'
                    cv2.circle(frame, (int(round(rcx)), int(round(rcy))), 5, VIS_COLORS['mid'], -1)

                if 'left_center_x' in frame_data and 'right_center_x' in frame_data:
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

        print(f"\n[OK] Tracked video saved: {output_video_path}")
        self._save_tracking_data()
        self._generate_summary()
        return self.tracking_data

    def _draw_overlay(self, frame, data):
        overlay = frame.copy()
        cv2.rectangle(overlay, (5, 5), (480, 145), (0, 0, 0), -1)
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
                        f"L mid: ({int(data['left_center_x'])},{int(data['left_center_y'])}) "
                        f"{data['left_confidence']:.2f} [{data['left_method']}]",
                        (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['left_dot'], 1)
        y += 25
        if 'right_center_x' in data:
            cv2.putText(frame,
                        f"R mid: ({int(data['right_center_x'])},{int(data['right_center_y'])}) "
                        f"{data['right_confidence']:.2f} [{data['right_method']}]",
                        (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['right_dot'], 1)
        y += 25
        if 'gaze_x' in data:
            cv2.putText(frame, f"Gaze: ({int(data['gaze_x'])},{int(data['gaze_y'])})",
                        (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['mid'], 1)

    def _save_tracking_data(self):
        df = pd.DataFrame(self.tracking_data)
        csv_path = self.output_dir / f"{self.video_path.stem}_tracking_data.csv"
        df.to_csv(csv_path, index=False)
        print(f"[OK] CSV saved: {csv_path}")

        json_path = self.output_dir / f"{self.video_path.stem}_tracking_data.json"
        with open(json_path, 'w') as f:
            json.dump(self.tracking_data, f, indent=2)
        print(f"[OK] JSON saved: {json_path}")

    def _generate_summary(self):
        df = pd.DataFrame(self.tracking_data)
        valid_df = df[df['face_detected'] == True]
        if len(valid_df) > 0:
            left_edge = (valid_df['left_method'] == 'edge_band').sum()
            right_edge = (valid_df['right_method'] == 'edge_band').sum()

            print(f"\n{'=' * 70}")
            print("SUMMARY")
            print(f"{'=' * 70}")
            print(f"Face Detected: {len(valid_df)}/{len(df)} frames ({len(valid_df) / len(df) * 100:.1f}%)")
            print(f"Left edge-based mids:  {left_edge}/{len(valid_df)} ({left_edge / len(valid_df) * 100:.1f}%)")
            print(f"Right edge-based mids: {right_edge}/{len(valid_df)} ({right_edge / len(df) * 100:.1f}%)")
            print(f"{'=' * 70}\n")

def main():
    print("\n" + "=" * 70)
    print("EYE TRACKING - RECORD & ANALYZE (Iris Edges Midpoint)")
    print("=" * 70)

    try:
        video_path, fps = record_video()
        use_video = video_path
    except Exception as e:
        print(f"\n[WARN] {e}")
        sample = _find_sample_video()
        if sample:
            print(f"Falling back to sample video: {sample}")
            use_video = sample
        else:
            print("No camera and no sample video found. Exiting.")
            return

    clear_output_dir("output")

    try:
        tracker = EyeTracker(use_video, output_dir="output")
        tracker.process_video()
        print("[OK] DONE. Check 'output/' folder.\n")
    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
