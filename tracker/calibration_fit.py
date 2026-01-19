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


def build_pairs(
    frames, 
    left_x_key, 
    left_y_key, 
    right_x_key, 
    right_y_key, 
    targets, 
    timebase_mode, 
    ts_key
):
    """
    Build calibration pairs using separate left/right eye centers.
    Handles 'epoch_ms' and 'relative_sec' logic for windowing.
    """
    pairs = []
    
    # Sort targets by timestamp_ms descending to find t0 (start time)
    # User's logic: sort targets by timestamp_ms ascending
    sorted_targets = sorted(targets, key=lambda x: x["timestamp_ms"])
    if not sorted_targets:
        return []
        
    t0_ms = sorted_targets[0]["timestamp_ms"]
    
    print(f"[calibration] Timebase Mode: {timebase_mode}")
    
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

            left_valid = lx is not None and ly is not None
            right_valid = rx is not None and ry is not None

            # Require at least one valid eye sample
            if not left_valid and not right_valid:
                continue

            valid_frames_used += 1

            if left_valid:
                left_x_samples.append(float(lx))
                left_y_samples.append(float(ly))

            if right_valid:
                right_x_samples.append(float(rx))
                right_y_samples.append(float(ry))
        
        # Compute statistics
        left_count = len(left_x_samples)
        right_count = len(right_x_samples)
        n_frames = valid_frames_used
        
        left_avg_x = median(left_x_samples) if left_x_samples else None
        left_avg_y = median(left_y_samples) if left_y_samples else None
        right_avg_x = median(right_x_samples) if right_x_samples else None
        right_avg_y = median(right_y_samples) if right_y_samples else None
        
        left_std_x = stddev(left_x_samples) if left_x_samples else None
        left_std_y = stddev(left_y_samples) if left_y_samples else None
        right_std_x = stddev(right_x_samples) if right_x_samples else None
        right_std_y = stddev(right_y_samples) if right_y_samples else None
        
        # Compute binocular gaze (for calibration fitting only)
        eye_avg_x = None
        eye_avg_y = None
        if left_avg_x is not None and right_avg_x is not None:
            eye_avg_x = (left_avg_x + right_avg_x) / 2.0
            eye_avg_y = (left_avg_y + right_avg_y) / 2.0
        elif left_avg_x is not None:
            eye_avg_x = left_avg_x
            eye_avg_y = left_avg_y
        elif right_avg_x is not None:
            eye_avg_x = right_avg_x
            eye_avg_y = right_avg_y
        
        # Validity check
        valid = n_frames >= MIN_FRAMES and eye_avg_x is not None and eye_avg_y is not None
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
            "eye_avg": {"x": eye_avg_x, "y": eye_avg_y},
            "gaze_avg": {"x": eye_avg_x, "y": eye_avg_y},  # For model fitting
            "valid": valid,
            "invalid_reason": invalid_reason,
        }
        pairs.append(entry)
    
    return pairs


def fit_affine(pairs):
    valid = [p for p in pairs if p.get("valid") and p["gaze_avg"]["x"] is not None]
    if len(valid) < 3:
        raise ValueError("Not enough valid pairs to fit affine model (need >= 3).")

    X = np.array([[p["gaze_avg"]["x"], p["gaze_avg"]["y"], 1.0] for p in valid], dtype=float)
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
            "eye_avg_x": p.get("eye_avg", {}).get("x"),
            "eye_avg_y": p.get("eye_avg", {}).get("y"),
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
        
        # Compute error using eye_avg (fallback to gaze_avg for legacy)
        gaze = p.get("eye_avg") or p.get("gaze_avg") or {}
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

    left_x_key, left_y_key, right_x_key, right_y_key = infer_eye_center_fields(frames)
    print(f"[calibration] using fields: L=({left_x_key},{left_y_key}) R=({right_x_key},{right_y_key})")
    print(f"[calibration] using timestamp mode: {ts_mode} (key={ts_key})")

    pairs = build_pairs(frames, left_x_key, left_y_key, right_x_key, right_y_key, targets, ts_mode, ts_key)

    valid_counts = [p["n_frames"] for p in pairs if p["n_frames"] is not None]
    print(f"[calibration] targets={len(pairs)} valid={len([p for p in pairs if p['valid']])} ")
    if valid_counts:
        print(f"[calibration] frames/window min={min(valid_counts)} max={max(valid_counts)}")

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
            writer.writerow(
                [
                    tgt.get("filename"),
                    tgt.get("x"),
                    tgt.get("y"),
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
        if p.get("gaze_avg", {}).get("x") is not None and p.get("gaze_avg", {}).get("y") is not None
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
        "input": "gaze_avg_xy",
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
