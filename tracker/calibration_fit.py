#!/usr/bin/env python3
import csv
import json
import math
import statistics
import sys
from pathlib import Path

import numpy as np

WINDOW_MS = 500
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


def infer_timestamp_field(frames):
    if not frames:
        raise ValueError("No frames available for timestamp detection.")
    keys = frames[0].keys()
    for k in ["timestamp_ms", "timestamp", "timestamp_sec", "time_sec", "time_s", "t"]:
        if k in keys:
            return k
    raise ValueError(f"No known timestamp field found. Keys: {sorted(keys)}")


def infer_timestamp_unit(values, key):
    max_v = max(values)
    key_is_ms = key.endswith("_ms")
    key_is_sec = key.endswith("_sec") or "sec" in key or key.endswith("_s")

    if max_v >= 1e12:
        return "epoch_ms"
    if max_v >= 1e9:
        if key_is_ms:
            return "epoch_ms"
        return "epoch_sec"
    if max_v >= 1e6:
        if key_is_sec:
            return "sec"
        return "ms"
    if key_is_ms:
        return "ms"
    return "sec"


def normalize_timestamps(frames, key, created_at_ms):
    raw_values = [f.get(key) for f in frames if f.get(key) is not None]
    if not raw_values:
        raise ValueError(f"No usable values for timestamp field '{key}'.")
    unit = infer_timestamp_unit(raw_values, key)

    def to_ms(v):
        if unit == "epoch_ms":
            return float(v)
        if unit == "epoch_sec":
            return float(v) * 1000.0
        if unit == "ms":
            return float(v) + (created_at_ms or 0)
        return (created_at_ms or 0) + round(float(v) * 1000.0)

    out = []
    for f in frames:
        v = f.get(key)
        if v is None:
            out.append(None)
        else:
            out.append(to_ms(v))
    return out, unit


def infer_gaze_fields(frames):
    if not frames:
        raise ValueError("No frames to infer gaze fields.")
    keys = frames[0].keys()
    pairs = [
        ("gaze_x", "gaze_y"),
        ("gaze_x_px", "gaze_y_px"),
        ("gaze_x_norm", "gaze_y_norm"),
        ("gaze_x_normalized", "gaze_y_normalized"),
        ("gaze_x_normed", "gaze_y_normed"),
    ]
    for gx, gy in pairs:
        if gx in keys and gy in keys:
            return gx, gy
    raise ValueError(f"No gaze fields found. Keys: {sorted(keys)}")


def mean(vals):
    return sum(vals) / len(vals) if vals else None


def stddev(vals):
    if len(vals) < 2:
        return 0.0
    return statistics.pstdev(vals)


def build_pairs(frames, frame_ts, gaze_x_key, gaze_y_key, targets):
    pairs = []
    for t in targets:
        t_ms = t["timestamp_ms"]
        # Window includes the last 500ms of gaze data up to and including the moment the target appeared.
        window_start = t_ms - WINDOW_MS
        window_end = t_ms

        window = []
        for f, ts in zip(frames, frame_ts):
            if ts is None:
                continue
            if ts < window_start or ts > window_end:
                continue
            gx = f.get(gaze_x_key)
            gy = f.get(gaze_y_key)
            if gx is None or gy is None:
                continue
            window.append((float(gx), float(gy)))

        n = len(window)
        avg_x = mean([g[0] for g in window]) if window else None
        avg_y = mean([g[1] for g in window]) if window else None
        std_x = stddev([g[0] for g in window]) if window else None
        std_y = stddev([g[1] for g in window]) if window else None

        entry = {
            "target": t,
            "gaze_avg": {"x": avg_x, "y": avg_y},
            "window_ms": WINDOW_MS,
            "n_frames": n,
            "std": {"x": std_x, "y": std_y},
            "valid": n >= MIN_FRAMES,
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
        if not p.get("valid"):
            per_target.append(
                {
                    "filename": tgt["filename"],
                    "x": tgt["x"],
                    "y": tgt["y"],
                    "n_frames": p["n_frames"],
                    "valid": False,
                }
            )
            continue

        gx = p["gaze_avg"]["x"]
        gy = p["gaze_avg"]["y"]
        sx_hat, sy_hat = predict_affine(coeffs_x, coeffs_y, gx, gy)
        dx = sx_hat - tgt["x"]
        dy = sy_hat - tgt["y"]
        err = math.hypot(dx, dy)
        errors.append(err)
        per_target.append(
            {
                "filename": tgt["filename"],
                "x": tgt["x"],
                "y": tgt["y"],
                "n_frames": p["n_frames"],
                "valid": True,
                "dx": dx,
                "dy": dy,
                "error_px": err,
            }
        )

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

    targets_path = find_targets_file(session_dir)
    tracking_path = find_tracking_file(session_dir)

    targets_data = load_json(targets_path)
    tracking_data = load_json(tracking_path)

    targets = targets_data.get("targets", [])
    if not targets:
        raise ValueError("No targets found in calibration_targets.json.")

    frames = tracking_data.get("frames", tracking_data)
    if not isinstance(frames, list):
        raise ValueError("Tracking data format not recognized; expected list or dict with 'frames'.")

    ts_key = infer_timestamp_field(frames)
    created_at_ms = targets_data.get("created_at_ms")
    frame_ts, ts_unit = normalize_timestamps(frames, ts_key, created_at_ms)

    gaze_x_key, gaze_y_key = infer_gaze_fields(frames)

    first_frame_ts = next((ts for ts in frame_ts if ts is not None), None)
    first_target_ts = targets[0].get("timestamp_ms")
    delta_ms = (first_frame_ts - first_target_ts) if (first_frame_ts is not None and first_target_ts is not None) else None

    pairs = build_pairs(frames, frame_ts, gaze_x_key, gaze_y_key, targets)

    valid_counts = [p["n_frames"] for p in pairs if p["n_frames"] is not None]
    print(f"[calibration] timestamp_field={ts_key} unit={ts_unit} created_at_ms={created_at_ms}")
    print(f"[calibration] first_tracking_ts={first_frame_ts} first_target_ts={first_target_ts} delta_ms={delta_ms}")
    print(f"[calibration] targets={len(pairs)} valid={len([p for p in pairs if p['valid']])}")
    if valid_counts:
        print(f"[calibration] frames/window min={min(valid_counts)} max={max(valid_counts)}")

    pairs_path = session_dir / "calibration_pairs.json"
    dataset_path = session_dir / "calibration_dataset.csv"
    model_path = session_dir / "calibration_model.json"
    report_path = session_dir / "calibration_report.json"

    pairs_payload = {
        "session_id": targets_data.get("session_id"),
        "timestamp_field": ts_key,
        "timestamp_unit": ts_unit,
        "window_ms": WINDOW_MS,
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
                "avg_gaze_x",
                "avg_gaze_y",
                "target_timestamp_ms",
                "n_frames",
            ]
        )
        for p in valid_pairs:
            tgt = p["target"]
            avg = p["gaze_avg"]
            writer.writerow(
                [
                    tgt.get("filename"),
                    tgt.get("x"),
                    tgt.get("y"),
                    avg.get("x"),
                    avg.get("y"),
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
                    "n_frames": p["n_frames"],
                    "valid": p["valid"],
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
        "window_ms": WINDOW_MS,
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
