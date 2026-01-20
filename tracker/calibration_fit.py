#!/usr/bin/env python3
import csv
import json
import math
import statistics
import sys
from pathlib import Path

import numpy as np

# Physiological fixation window after target appears
# User needs ~500ms to complete saccade and begin stable fixation
# Sample during stable period from 500-1250ms after target onset (750ms duration)
WINDOW_START_OFFSET_MS = 500
WINDOW_END_OFFSET_MS = 1250
MIN_FRAMES = 5
NORM_EPS = 1e-6
NORM_CLAMP_MIN = -0.5
NORM_CLAMP_MAX = 1.5


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def find_tracking_file(session_dir: Path) -> Path:
    candidates = list(session_dir.rglob("*_tracking_data.json"))
    if not candidates:
        raise FileNotFoundError("No *_tracking_data.json found under session folder.")
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def find_targets_file(session_dir: Path) -> Path:
    direct = session_dir / "calibration_targets.json"
    if direct.exists():
        return direct
    candidates = list(session_dir.rglob("calibration_targets.json"))
    if not candidates:
        raise FileNotFoundError("calibration_targets.json not found in session folder.")
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


def detect_timebase(frames):
    """
    Detects whether to use epoch_ms or relative_sec based on frame fields.
    Returns (mode, timestamp_key).
    mode: 'epoch_ms' | 'relative_sec' | 'unknown'
    """
    if not frames:
        return "unknown", None

    # 1. Check for epoch ms (>= 1e9)
    # Check a sample of frames to be sure
    check_limit = min(len(frames), 200)
    for i in range(check_limit):
        val = frames[i].get("timestamp_ms")
        if val is not None and isinstance(val, (int, float)) and val >= 1e9:
            return "epoch_ms", "timestamp_ms"

    # 2. Check for timestamp_sec
    # Inspect keys of the first frame (or a few)
    # We check if the key exists in the first frame
    if "timestamp_sec" in frames[0]:
         return "relative_sec", "timestamp_sec"

    return "unknown", None


def infer_eye_center_fields(frames):
    """
    Returns tuple: (left_x, left_y, right_x, right_y)
    Prefers *_raw fields, falls back to standard fields.
    """
    if not frames:
        raise ValueError("No frames to infer eye center fields.")
    
    keys = frames[0].keys()
    
    # Prefer raw values (unsmoothed)
    if all(k in keys for k in ["left_center_x_raw", "left_center_y_raw", 
                                "right_center_x_raw", "right_center_y_raw"]):
        return ("left_center_x_raw", "left_center_y_raw", 
                "right_center_x_raw", "right_center_y_raw")
    
    # Fallback to standard fields
    if all(k in keys for k in ["left_center_x", "left_center_y", 
                                "right_center_x", "right_center_y"]):
        return ("left_center_x", "left_center_y", 
                "right_center_x", "right_center_y")
    
    raise ValueError(f"No eye center fields found. Keys: {sorted(keys)}")


def mean(vals):
    return sum(vals) / len(vals) if vals else None


def median(vals):
    return statistics.median(vals) if vals else None


def stddev(vals):
    if len(vals) < 2:
        return 0.0
    return statistics.pstdev(vals)


def clamp(val, lo, hi):
    return max(lo, min(hi, val))


def is_valid_number(val):
    return isinstance(val, (int, float)) and not math.isnan(val)


def compute_norm(center_x, center_y, lr_left_x, lr_right_x, tb_top_y, tb_bottom_y):
    if not all(is_valid_number(v) for v in [center_x, center_y, lr_left_x, lr_right_x, tb_top_y, tb_bottom_y]):
        return None
    width = lr_right_x - lr_left_x
    height = tb_bottom_y - tb_top_y
    if width <= NORM_EPS or height <= NORM_EPS:
        return None
    nx = (center_x - lr_left_x) / width
    ny = (center_y - tb_top_y) / height
    return (
        clamp(nx, NORM_CLAMP_MIN, NORM_CLAMP_MAX),
        clamp(ny, NORM_CLAMP_MIN, NORM_CLAMP_MAX),
    )


def get_eye_box(frame, side):
    if side == "left":
        keys = ("left_eye_left_x", "left_eye_right_x", "left_eye_top_y", "left_eye_bottom_y")
    else:
        keys = ("right_eye_left_x", "right_eye_right_x", "right_eye_top_y", "right_eye_bottom_y")

    vals = [frame.get(k) for k in keys]
    if all(is_valid_number(v) for v in vals):
        return (*vals, "eye")
    return (None, None, None, None, "missing")


def get_norm_center(frame, side):
    mp_x = frame.get(f"{side}_mp_x")
    mp_y = frame.get(f"{side}_mp_y")
    if is_valid_number(mp_x) and is_valid_number(mp_y):
        return mp_x, mp_y, "mp"
    return None, None, "missing"


def fmt_num(val, digits=4):
    if val is None:
        return "None"
    if isinstance(val, float):
        if math.isnan(val):
            return "nan"
        return f"{val:.{digits}f}"
    return str(val)


def build_pairs(
    frames, 
    left_x_key, 
    left_y_key, 
    right_x_key, 
    right_y_key, 
    targets, 
    timebase_mode, 
    ts_key,
    debug=False
):
    """
    Build calibration pairs using normalized gaze features.
    Handles 'epoch_ms' and 'relative_sec' logic for windowing.
    """
    pairs = []
    norm_min_x = None
    norm_max_x = None
    norm_min_y = None
    norm_max_y = None
    
    # Sort targets by timestamp_ms descending to find t0 (start time)
    # User's logic: sort targets by timestamp_ms ascending
    sorted_targets = sorted(targets, key=lambda x: x["timestamp_ms"])
    if not sorted_targets:
        empty_stats = {"min_x": None, "max_x": None, "min_y": None, "max_y": None}
        return [], empty_stats, [] if debug else None
        
    t0_ms = sorted_targets[0]["timestamp_ms"]
    
    print(f"[calibration] Timebase Mode: {timebase_mode}")
    
    debug_targets = [] if debug else None

    for t in sorted_targets:
        t_ms = t["timestamp_ms"]
        
        # Calculate window based on mode
        window_start = 0.0
        window_end = 0.0
        target_info_str = ""
        
        if timebase_mode == "epoch_ms":
            # Window in ms
            window_start = t_ms + WINDOW_START_OFFSET_MS
            window_end = t_ms + WINDOW_END_OFFSET_MS
            target_info_str = f"T={t_ms:.1f} (epoch)"
            
        elif timebase_mode == "relative_sec":
            # Window in seconds
            target_rel_sec = (t_ms - t0_ms) / 1000.0
            window_start = target_rel_sec + (WINDOW_START_OFFSET_MS / 1000.0)
            window_end = target_rel_sec + (WINDOW_END_OFFSET_MS / 1000.0)
            target_info_str = f"T_rel={target_rel_sec:.3f}s"
        else:
            # Unknown mode, skip
            continue
            
        # Collect valid samples in window
        left_x_samples = []
        left_y_samples = []
        right_x_samples = []
        right_y_samples = []
        left_norm_x_samples = []
        left_norm_y_samples = []
        right_norm_x_samples = []
        right_norm_y_samples = []
        gaze_norm_x_samples = []
        gaze_norm_y_samples = []

        target_debug = None
        if debug:
            target_debug = {
                "filename": t["filename"],
                "samples": [],
            }
        
        frames_in_window_count = 0
        valid_frames_used = 0
        
        for f in frames:
            ts = f.get(ts_key)
            if ts is None:
                continue
            
            # Check window
            if ts < window_start or ts > window_end:
                continue
            
            frames_in_window_count += 1
            
            # Filtering criteria (calibration mode: relaxed)
            if not f.get("face_detected", False):
                continue
            
            lx = f.get(left_x_key)
            ly = f.get(left_y_key)
            rx = f.get(right_x_key)
            ry = f.get(right_y_key)

            left_box_left, left_box_right, left_box_top, left_box_bottom, left_box_src = get_eye_box(
                f, "left"
            )
            right_box_left, right_box_right, right_box_top, right_box_bottom, right_box_src = get_eye_box(
                f, "right"
            )

            left_cx, left_cy, left_center_src = get_norm_center(f, "left")
            right_cx, right_cy, right_center_src = get_norm_center(f, "right")

            left_norm = compute_norm(
                left_cx,
                left_cy,
                left_box_left,
                left_box_right,
                left_box_top,
                left_box_bottom,
            )
            right_norm = compute_norm(
                right_cx,
                right_cy,
                right_box_left,
                right_box_right,
                right_box_top,
                right_box_bottom,
            )

            left_valid = left_norm is not None
            right_valid = right_norm is not None

            # Require at least one valid eye sample
            if not left_valid and not right_valid:
                continue

            valid_frames_used += 1

            if left_valid:
                left_x_samples.append(float(left_cx))
                left_y_samples.append(float(left_cy))
                left_norm_x_samples.append(left_norm[0])
                left_norm_y_samples.append(left_norm[1])

            if right_valid:
                right_x_samples.append(float(right_cx))
                right_y_samples.append(float(right_cy))
                right_norm_x_samples.append(right_norm[0])
                right_norm_y_samples.append(right_norm[1])

            if left_valid and right_valid:
                gaze_norm_x = (left_norm[0] + right_norm[0]) / 2.0
                gaze_norm_y = (left_norm[1] + right_norm[1]) / 2.0
            elif left_valid:
                gaze_norm_x = left_norm[0]
                gaze_norm_y = left_norm[1]
            else:
                gaze_norm_x = right_norm[0]
                gaze_norm_y = right_norm[1]

            gaze_norm_x_samples.append(gaze_norm_x)
            gaze_norm_y_samples.append(gaze_norm_y)
            norm_min_x = gaze_norm_x if norm_min_x is None else min(norm_min_x, gaze_norm_x)
            norm_max_x = gaze_norm_x if norm_max_x is None else max(norm_max_x, gaze_norm_x)
            norm_min_y = gaze_norm_y if norm_min_y is None else min(norm_min_y, gaze_norm_y)
            norm_max_y = gaze_norm_y if norm_max_y is None else max(norm_max_y, gaze_norm_y)

            if debug and target_debug is not None:
                left_mid_x = (
                    (left_box_left + left_box_right) / 2.0
                    if is_valid_number(left_box_left) and is_valid_number(left_box_right)
                    else None
                )
                left_mid_y = (
                    (left_box_top + left_box_bottom) / 2.0
                    if is_valid_number(left_box_top) and is_valid_number(left_box_bottom)
                    else None
                )
                right_mid_x = (
                    (right_box_left + right_box_right) / 2.0
                    if is_valid_number(right_box_left) and is_valid_number(right_box_right)
                    else None
                )
                right_mid_y = (
                    (right_box_top + right_box_bottom) / 2.0
                    if is_valid_number(right_box_top) and is_valid_number(right_box_bottom)
                    else None
                )
                target_debug["samples"].append(
                    {
                        "ts": f.get(ts_key),
                        "left_center_x": lx,
                        "left_center_y": ly,
                        "left_mp_x": f.get("left_mp_x"),
                        "left_mp_y": f.get("left_mp_y"),
                        "left_box_left_x": left_box_left,
                        "left_box_right_x": left_box_right,
                        "left_box_top_y": left_box_top,
                        "left_box_bottom_y": left_box_bottom,
                        "left_box_src": left_box_src,
                        "left_center_src": left_center_src,
                        "left_nx": left_norm[0] if left_norm else None,
                        "left_ny": left_norm[1] if left_norm else None,
                        "left_mid_x": left_mid_x,
                        "left_mid_y": left_mid_y,
                        "left_delta_x": (left_cx - left_mid_x) if left_cx is not None and left_mid_x is not None else None,
                        "left_delta_y": (left_cy - left_mid_y) if left_cy is not None and left_mid_y is not None else None,
                        "left_lr_left_x": f.get("left_lr_left_x"),
                        "left_lr_right_x": f.get("left_lr_right_x"),
                        "left_tb_top_y": f.get("left_tb_top_y"),
                        "left_tb_bottom_y": f.get("left_tb_bottom_y"),
                        "right_center_x": rx,
                        "right_center_y": ry,
                        "right_mp_x": f.get("right_mp_x"),
                        "right_mp_y": f.get("right_mp_y"),
                        "right_box_left_x": right_box_left,
                        "right_box_right_x": right_box_right,
                        "right_box_top_y": right_box_top,
                        "right_box_bottom_y": right_box_bottom,
                        "right_box_src": right_box_src,
                        "right_center_src": right_center_src,
                        "right_nx": right_norm[0] if right_norm else None,
                        "right_ny": right_norm[1] if right_norm else None,
                        "right_mid_x": right_mid_x,
                        "right_mid_y": right_mid_y,
                        "right_delta_x": (right_cx - right_mid_x) if right_cx is not None and right_mid_x is not None else None,
                        "right_delta_y": (right_cy - right_mid_y) if right_cy is not None and right_mid_y is not None else None,
                        "right_lr_left_x": f.get("right_lr_left_x"),
                        "right_lr_right_x": f.get("right_lr_right_x"),
                        "right_tb_top_y": f.get("right_tb_top_y"),
                        "right_tb_bottom_y": f.get("right_tb_bottom_y"),
                    }
                )
        
        # Compute statistics
        left_count = len(left_x_samples)
        right_count = len(right_x_samples)
        n_frames = valid_frames_used
        
        left_avg_x = median(left_x_samples) if left_x_samples else None
        left_avg_y = median(left_y_samples) if left_y_samples else None
        right_avg_x = median(right_x_samples) if right_x_samples else None
        right_avg_y = median(right_y_samples) if right_y_samples else None
        gaze_norm_avg_x = median(gaze_norm_x_samples) if gaze_norm_x_samples else None
        gaze_norm_avg_y = median(gaze_norm_y_samples) if gaze_norm_y_samples else None
        
        left_std_x = stddev(left_x_samples) if left_x_samples else None
        left_std_y = stddev(left_y_samples) if left_y_samples else None
        right_std_x = stddev(right_x_samples) if right_x_samples else None
        right_std_y = stddev(right_y_samples) if right_y_samples else None
        
        # Compute binocular gaze (pixel space, for debugging only)
        eye_avg_x = None
        eye_avg_y = None
        eye_x_samples = []
        eye_y_samples = []

        # Build binocular samples for variance calculation
        if left_x_samples and right_x_samples:
            # Use binocular average for each frame
            for i in range(min(len(left_x_samples), len(right_x_samples))):
                eye_x_samples.append((left_x_samples[i] + right_x_samples[i]) / 2.0)
                eye_y_samples.append((left_y_samples[i] + right_y_samples[i]) / 2.0)
            eye_avg_x = (left_avg_x + right_avg_x) / 2.0
            eye_avg_y = (left_avg_y + right_avg_y) / 2.0
        elif left_x_samples:
            # Use left eye only
            eye_x_samples = left_x_samples[:]
            eye_y_samples = left_y_samples[:]
            eye_avg_x = left_avg_x
            eye_avg_y = left_avg_y
        elif right_x_samples:
            # Use right eye only
            eye_x_samples = right_x_samples[:]
            eye_y_samples = right_y_samples[:]
            eye_avg_x = right_avg_x
            eye_avg_y = right_avg_y

        # Calculate variance (range = max - min) for binocular gaze
        x_variance = None
        y_variance = None
        if eye_x_samples and eye_y_samples:
            x_variance = max(eye_x_samples) - min(eye_x_samples)
            y_variance = max(eye_y_samples) - min(eye_y_samples)

        # Calculate reaction time: time from target appearance until gaze reaches within 2x variance
        reaction_time_ms = None
        if eye_avg_x is not None and eye_avg_y is not None and x_variance is not None and y_variance is not None:
            # Combined variance threshold (use Euclidean distance)
            variance_threshold = 2.0 * math.hypot(x_variance, y_variance)

            # Find first frame where gaze is within threshold of target average
            target_appearance_time = t_ms
            for f in frames:
                ts = f.get(ts_key)
                if ts is None:
                    continue

                # Convert timestamp to ms for comparison
                if timebase_mode == "relative_sec":
                    frame_time_ms = t0_ms + (ts * 1000.0)
                else:
                    frame_time_ms = ts

                # Only check frames after target appears
                if frame_time_ms < target_appearance_time:
                    continue

                # Get gaze coordinates for this frame
                left_cx, left_cy, _ = get_norm_center(f, "left")
                right_cx, right_cy, _ = get_norm_center(f, "right")

                # Calculate binocular gaze for this frame
                frame_gaze_x = None
                frame_gaze_y = None
                if left_cx is not None and right_cx is not None:
                    frame_gaze_x = (left_cx + right_cx) / 2.0
                    frame_gaze_y = (left_cy + right_cy) / 2.0
                elif left_cx is not None:
                    frame_gaze_x = left_cx
                    frame_gaze_y = left_cy
                elif right_cx is not None:
                    frame_gaze_x = right_cx
                    frame_gaze_y = right_cy

                if frame_gaze_x is not None and frame_gaze_y is not None:
                    # Calculate distance from target average
                    distance = math.hypot(frame_gaze_x - eye_avg_x, frame_gaze_y - eye_avg_y)

                    # Check if within threshold (gaze has "reached" target)
                    if distance <= variance_threshold:
                        reaction_time_ms = frame_time_ms - target_appearance_time
                        break

        # Validity check
        valid = n_frames >= MIN_FRAMES
        invalid_reason = None
        if not valid:
            invalid_reason = (
                f"Insufficient valid frames after calibration filtering: {n_frames} < {MIN_FRAMES}"
            )
        
        # Debug log as requested
        # "target filename, target_rel_sec, window, frames_in_window, frames_after_filters"
        print(
            f"[window] {t['filename']} "
            f"{target_info_str} "
            f"win=[{window_start:.3f},{window_end:.3f}] "
            f"in_win={frames_in_window_count} "
            f"valid_frames={valid_frames_used} "
            f"L={left_count} R={right_count} "
            f"valid={valid} ({n_frames} used)"
        )
        
        entry = {
            "target": t,
            "window_start_ms": window_start if timebase_mode == "epoch_ms" else None, # preserve ms if possible, else might be sec
            "window_end_ms": window_end if timebase_mode == "epoch_ms" else None,
            "window_start_val": window_start,
            "window_end_val": window_end,
            "n_frames": n_frames,
            "raw_frames_in_window": frames_in_window_count,
            "valid_frames_used": valid_frames_used,
            "left_count": left_count,
            "right_count": right_count,
            "left_avg": {"x": left_avg_x, "y": left_avg_y},
            "right_avg": {"x": right_avg_x, "y": right_avg_y},
            "left_std": {"x": left_std_x, "y": left_std_y},
            "right_std": {"x": right_std_x, "y": right_std_y},
            "left_norm_count": len(left_norm_x_samples),
            "right_norm_count": len(right_norm_x_samples),
            "gaze_norm_avg": {"x": gaze_norm_avg_x, "y": gaze_norm_avg_y},
            "eye_avg": {"x": eye_avg_x, "y": eye_avg_y},
            "gaze_avg": {"x": eye_avg_x, "y": eye_avg_y},  # Debug only (pixel space)
            "x_variance": x_variance,
            "y_variance": y_variance,
            "reaction_time_ms": reaction_time_ms,
            "valid": valid,
            "invalid_reason": invalid_reason,
        }
        pairs.append(entry)
        if debug and target_debug is not None:
            target_debug["gaze_norm_avg"] = {"x": gaze_norm_avg_x, "y": gaze_norm_avg_y}
            target_debug["valid_frames_used"] = valid_frames_used
            debug_targets.append(target_debug)
    
    norm_stats = {
        "min_x": norm_min_x,
        "max_x": norm_max_x,
        "min_y": norm_min_y,
        "max_y": norm_max_y,
    }
    return pairs, norm_stats, debug_targets


def fit_affine(pairs):
    valid = [
        p
        for p in pairs
        if p.get("valid")
        and p.get("gaze_norm_avg", {}).get("x") is not None
        and p.get("gaze_norm_avg", {}).get("y") is not None
    ]
    if len(valid) < 3:
        raise ValueError("Not enough valid pairs to fit affine model (need >= 3).")

    X = np.array(
        [[p["gaze_norm_avg"]["x"], p["gaze_norm_avg"]["y"], 1.0] for p in valid],
        dtype=float,
    )
    sx = np.array([p["target"]["x"] for p in valid], dtype=float)
    sy = np.array([p["target"]["y"] for p in valid], dtype=float)

    coeffs_x, _, _, _ = np.linalg.lstsq(X, sx, rcond=None)
    coeffs_y, _, _, _ = np.linalg.lstsq(X, sy, rcond=None)
    return coeffs_x.tolist(), coeffs_y.tolist()


def predict_affine(coeffs_x, coeffs_y, gx, gy):
    sx = coeffs_x[0] * gx + coeffs_x[1] * gy + coeffs_x[2]
    sy = coeffs_y[0] * gx + coeffs_y[1] * gy + coeffs_y[2]
    return sx, sy


def build_report(pairs, coeffs_x, coeffs_y):
    per_target = []
    errors = []
    
    for p in pairs:
        tgt = p["target"]
        
        base_entry = {
            "filename": tgt["filename"],
            "x": tgt["x"],
            "y": tgt["y"],
            "window_start_ms": p["window_start_ms"],
            "window_end_ms": p["window_end_ms"],
            "n_frames": p["n_frames"],
            "raw_frames_in_window": p.get("raw_frames_in_window"),
            "valid_frames_used": p.get("valid_frames_used"),
            "left_count": p.get("left_count"),
            "right_count": p.get("right_count"),
            "left_avg_x": p["left_avg"]["x"],
            "left_avg_y": p["left_avg"]["y"],
            "right_avg_x": p["right_avg"]["x"],
            "right_avg_y": p["right_avg"]["y"],
            "gaze_norm_avg_x": p.get("gaze_norm_avg", {}).get("x"),
            "gaze_norm_avg_y": p.get("gaze_norm_avg", {}).get("y"),
            "eye_avg_x": p.get("eye_avg", {}).get("x"),
            "eye_avg_y": p.get("eye_avg", {}).get("y"),
            "x_variance": p.get("x_variance"),
            "y_variance": p.get("y_variance"),
            "reaction_time_ms": p.get("reaction_time_ms"),
            "left_std_x": p["left_std"]["x"],
            "left_std_y": p["left_std"]["y"],
            "right_std_x": p["right_std"]["x"],
            "right_std_y": p["right_std"]["y"],
            "valid": p["valid"],
        }
        
        if not p.get("valid"):
            base_entry["invalid_reason"] = p.get("invalid_reason", "Unknown")
            per_target.append(base_entry)
            continue
        
        # Compute error using gaze_norm_avg (fallback to gaze_avg for legacy)
        gaze = p.get("gaze_norm_avg") or p.get("gaze_avg") or {}
        gx = gaze.get("x")
        gy = gaze.get("y")
        
        if gx is not None and gy is not None:
            sx_hat, sy_hat = predict_affine(coeffs_x, coeffs_y, gx, gy)
            dx = sx_hat - tgt["x"]
            dy = sy_hat - tgt["y"]
            err = math.hypot(dx, dy)
            errors.append(err)
            
            base_entry["dx"] = dx
            base_entry["dy"] = dy
            base_entry["error_px"] = err
        
        per_target.append(base_entry)
    
    mean_err = mean(errors) if errors else None
    median_err = statistics.median(errors) if errors else None
    rmse = math.sqrt(mean([e * e for e in errors])) if errors else None

    report = {
        "num_targets": len(pairs),
        "valid_pairs": len([p for p in pairs if p.get("valid")]),
        "mean_error_px": mean_err,
        "median_error_px": median_err,
        "rmse_px": rmse,
        "per_target": per_target,
    }
    return report


def main():
    if len(sys.argv) < 2:
        print("Usage: python tracker/calibration_fit.py recordings/<session_id>")
        sys.exit(1)

    session_dir = Path(sys.argv[1]).resolve()
    if not session_dir.exists():
        raise FileNotFoundError(f"Session folder does not exist: {session_dir}")

    # Check if we're in parent folder with nested session_* subfolder
    # (calibration_targets.json is in parent, but recording.mp4 is in nested session_*)
    nested_sessions = list(session_dir.glob("session_*"))
    if nested_sessions:
        # Use the most recent session folder as the actual output location
        nested_sessions.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        actual_session_dir = nested_sessions[0]
        print(f"[calibration] detected nested session: {actual_session_dir.name}")
        print(f"[calibration] targets from: {session_dir.name}")
        print(f"[calibration] reports to: {actual_session_dir.name}")
    else:
        actual_session_dir = session_dir

    targets_path = find_targets_file(session_dir)
    tracking_path = find_tracking_file(actual_session_dir)

    targets_data = load_json(targets_path)
    tracking_data = load_json(tracking_path)

    targets = targets_data.get("targets", [])
    if not targets:
        raise ValueError("No targets found in calibration_targets.json.")

    frames = tracking_data.get("frames", tracking_data)
    if not isinstance(frames, list):
        raise ValueError("Tracking data format not recognized; expected list or dict with 'frames'.")

    ts_mode, ts_key = detect_timebase(frames)
    if ts_mode == "unknown":
        raise ValueError("Could not detect timebase (checked 'timestamp_ms' and 'timestamp_sec').")

    required_norm_keys = [
        "left_mp_x",
        "left_mp_y",
        "right_mp_x",
        "right_mp_y",
        "left_eye_left_x",
        "left_eye_right_x",
        "left_eye_top_y",
        "left_eye_bottom_y",
        "right_eye_left_x",
        "right_eye_right_x",
        "right_eye_top_y",
        "right_eye_bottom_y",
    ]
    missing_norm = [k for k in required_norm_keys if k not in frames[0]]
    if missing_norm:
        raise ValueError(
            "Tracking data missing required eye-box/iris fields for calibration "
            "(re-run tracker to regenerate tracking data with left_eye_*/right_eye_* fields). "
            "Missing: " + ", ".join(missing_norm)
        )

    left_x_key, left_y_key, right_x_key, right_y_key = infer_eye_center_fields(frames)
    print(f"[calibration] using fields: L=({left_x_key},{left_y_key}) R=({right_x_key},{right_y_key})")
    print(f"[calibration] using timestamp mode: {ts_mode} (key={ts_key})")

    pairs, norm_stats, debug_targets = build_pairs(
        frames, left_x_key, left_y_key, right_x_key, right_y_key, targets, ts_mode, ts_key, debug=True
    )

    valid_counts = [p["n_frames"] for p in pairs if p["n_frames"] is not None]
    print(f"[calibration] targets={len(pairs)} valid={len([p for p in pairs if p['valid']])} ")
    if valid_counts:
        print(f"[calibration] frames/window min={min(valid_counts)} max={max(valid_counts)}")
    if norm_stats.get("min_x") is not None:
        print(
            f"[calibration] gaze_norm range nx=[{norm_stats['min_x']:.3f},{norm_stats['max_x']:.3f}] "
            f"ny=[{norm_stats['min_y']:.3f},{norm_stats['max_y']:.3f}]"
        )
        range_x = norm_stats["max_x"] - norm_stats["min_x"]
        range_y = norm_stats["max_y"] - norm_stats["min_y"]
        if range_x < 0.10 or range_y < 0.10:
            print(
                f"[calibration][error] gaze_norm collapsed: "
                f"nx_range={range_x:.4f} ny_range={range_y:.4f}"
            )
            for p in pairs:
                gaze_norm = p.get("gaze_norm_avg", {})
                print(
                    "[calibration][debug] target "
                    f"{p['target']['filename']} gaze_norm_avg=({fmt_num(gaze_norm.get('x'))},"
                    f"{fmt_num(gaze_norm.get('y'))}) valid_frames={p.get('valid_frames_used')}"
                )
            if debug_targets:
                for tgt in debug_targets:
                    print(f"[calibration][debug] target {tgt['filename']} samples={len(tgt['samples'])}")
                    for s in tgt["samples"]:
                        print(
                            "[calibration][debug] "
                            f"{tgt['filename']} "
                            f"ts={fmt_num(s.get('ts'))} "
                            f"Lx={fmt_num(s.get('left_center_x'))} "
                            f"LlrL={fmt_num(s.get('left_lr_left_x'))} "
                            f"LlrR={fmt_num(s.get('left_lr_right_x'))} "
                            f"Lnx={fmt_num(s.get('left_nx'))} "
                            f"Ly={fmt_num(s.get('left_center_y'))} "
                            f"LtbT={fmt_num(s.get('left_tb_top_y'))} "
                            f"LtbB={fmt_num(s.get('left_tb_bottom_y'))} "
                            f"Lny={fmt_num(s.get('left_ny'))} "
                            f"Rx={fmt_num(s.get('right_center_x'))} "
                            f"RlrL={fmt_num(s.get('right_lr_left_x'))} "
                            f"RlrR={fmt_num(s.get('right_lr_right_x'))} "
                            f"Rnx={fmt_num(s.get('right_nx'))} "
                            f"Ry={fmt_num(s.get('right_center_y'))} "
                            f"RtbT={fmt_num(s.get('right_tb_top_y'))} "
                            f"RtbB={fmt_num(s.get('right_tb_bottom_y'))} "
                            f"Rny={fmt_num(s.get('right_ny'))} "
                            f"Lsrc={s.get('left_box_src')} "
                            f"Rsrc={s.get('right_box_src')} "
                            f"LmidDx={fmt_num(s.get('left_delta_x'))} "
                            f"RmidDx={fmt_num(s.get('right_delta_x'))}"
                        )
            raise ValueError(
                f"Collapsed gaze_norm features: nx_range={range_x:.4f} ny_range={range_y:.4f}"
            )

    # Write outputs to actual_session_dir (where recording.mp4 is)
    pairs_path = actual_session_dir / "calibration_pairs.json"
    dataset_path = actual_session_dir / "calibration_dataset.csv"
    model_path = actual_session_dir / "calibration_model.json"
    report_path = actual_session_dir / "calibration_report.json"

    pairs_payload = {
        "session_id": targets_data.get("session_id"),
        "timestamp_field": ts_key,
        "timestamp_unit": ts_mode,
        "window_ms": WINDOW_END_OFFSET_MS - WINDOW_START_OFFSET_MS,
        "min_frames": MIN_FRAMES,
        "pairs": pairs,
    }

    valid_pairs = [p for p in pairs if p.get("valid")]
    pairs_path.write_text(json.dumps(pairs_payload, indent=2), encoding="utf-8")

    with dataset_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "target_filename",
                "target_x",
                "target_y",
                "gaze_norm_x",
                "gaze_norm_y",
                "left_avg_x",
                "left_avg_y",
                "right_avg_x",
                "right_avg_y",
                "gaze_avg_x",
                "gaze_avg_y",
                "target_timestamp_ms",
                "n_frames",
            ]
        )
        for p in valid_pairs:
            tgt = p["target"]
            left_avg = p["left_avg"]
            right_avg = p["right_avg"]
            gaze_avg = p["gaze_avg"]
            gaze_norm = p.get("gaze_norm_avg", {})
            writer.writerow(
                [
                    tgt.get("filename"),
                    tgt.get("x"),
                    tgt.get("y"),
                    gaze_norm.get("x"),
                    gaze_norm.get("y"),
                    left_avg.get("x"),
                    left_avg.get("y"),
                    right_avg.get("x"),
                    right_avg.get("y"),
                    gaze_avg.get("x"),
                    gaze_avg.get("y"),
                    tgt.get("timestamp_ms"),
                    p.get("n_frames"),
                ]
            )

    valid_for_fit = [
        p
        for p in valid_pairs
        if p.get("gaze_norm_avg", {}).get("x") is not None
        and p.get("gaze_norm_avg", {}).get("y") is not None
    ]

    if len(valid_for_fit) < 3:
        report_payload = {
            "num_targets": len(pairs),
            "valid_pairs": len(valid_for_fit),
            "mean_error_px": None,
            "median_error_px": None,
            "rmse_px": None,
            "per_target": [
                {
                    "filename": p["target"]["filename"],
                    "x": p["target"]["x"],
                    "y": p["target"]["y"],
                    "window_start_ms": p["window_start_ms"],
                    "window_end_ms": p["window_end_ms"],
                    "n_frames": p["n_frames"],
                    "raw_frames_in_window": p.get("raw_frames_in_window"),
                    "valid_frames_used": p.get("valid_frames_used"),
                    "left_count": p.get("left_count"),
                    "right_count": p.get("right_count"),
                    "left_avg_x": p["left_avg"]["x"],
                    "left_avg_y": p["left_avg"]["y"],
                    "right_avg_x": p["right_avg"]["x"],
                    "right_avg_y": p["right_avg"]["y"],
                    "gaze_norm_avg_x": p.get("gaze_norm_avg", {}).get("x"),
                    "gaze_norm_avg_y": p.get("gaze_norm_avg", {}).get("y"),
                    "eye_avg_x": p.get("eye_avg", {}).get("x"),
                    "eye_avg_y": p.get("eye_avg", {}).get("y"),
                    "left_std_x": p["left_std"]["x"],
                    "left_std_y": p["left_std"]["y"],
                    "right_std_x": p["right_std"]["x"],
                    "right_std_y": p["right_std"]["y"],
                    "valid": p["valid"],
                    "invalid_reason": p.get("invalid_reason"),
                }
                for p in pairs
            ],
        }
        report_path.write_text(json.dumps(report_payload, indent=2), encoding="utf-8")
        print(f"[calibration] wrote {pairs_path}")
        print(f"[calibration] wrote {dataset_path}")
        print(f"[calibration] wrote {report_path}")
        print("[calibration] not enough valid pairs to fit model (need >= 3).")
        return

    coeffs_x, coeffs_y = fit_affine(pairs)

    model_payload = {
        "model_type": "affine_2d",
        "window_ms": WINDOW_END_OFFSET_MS - WINDOW_START_OFFSET_MS,
        "input": "gaze_norm_xy",
        "output": "screen_xy_pixels",
        "coeffs": {"sx": coeffs_x, "sy": coeffs_y},
    }

    report_payload = build_report(pairs, coeffs_x, coeffs_y)

    model_path.write_text(json.dumps(model_payload, indent=2), encoding="utf-8")
    report_path.write_text(json.dumps(report_payload, indent=2), encoding="utf-8")

    print(f"[calibration] wrote {pairs_path}")
    print(f"[calibration] wrote {dataset_path}")
    print(f"[calibration] wrote {model_path}")
    print(f"[calibration] wrote {report_path}")
    if report_payload.get("mean_error_px") is not None:
        print(
            f"[calibration] mean_error_px={report_payload['mean_error_px']:.2f} "
            f"median_error_px={report_payload['median_error_px']:.2f} "
            f"rmse_px={report_payload['rmse_px']:.2f}"
        )


if __name__ == "__main__":
    main()
