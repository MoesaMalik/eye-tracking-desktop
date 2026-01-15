import argparse
import json
import signal
import sys
import time

import cv2
import mediapipe as mp

try:
    from .camera import _find_working_camera
    from .head_positioning import HeadPositioner
except (ImportError, ValueError):
    from camera import _find_working_camera
    from head_positioning import HeadPositioner

stop_requested = False


def _handle_stop(signum, _frame):
    global stop_requested
    stop_requested = True
    print(f"[INFO] Received signal {signum}; stopping...", file=sys.stderr)


def parse_args():
    parser = argparse.ArgumentParser(description="Live head positioning stream")
    parser.add_argument("--cam", type=int, default=0, help="Camera index")
    parser.add_argument("--fps", type=float, default=30.0, help="Max output FPS")
    parser.add_argument(
        "--jsonl",
        action="store_true",
        default=True,
        help="Emit JSON lines to stdout (default: true)",
    )
    parser.add_argument(
        "--no-jsonl",
        dest="jsonl",
        action="store_false",
        help="Disable JSON line output",
    )
    return parser.parse_args()


def emit_json(payload):
    line = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def main():
    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)
    args = parse_args()

    cap, used_idx = _find_working_camera(args.cam)
    if cap is None:
        print(f"[ERROR] Camera not available at index {args.cam}", file=sys.stderr)
        sys.exit(1)

    if used_idx != args.cam:
        print(f"[INFO] Using camera index {used_idx}", file=sys.stderr)

    if not hasattr(mp, "solutions"):
        print(
            "[ERROR] mediapipe missing solutions API; install mediapipe==0.10.14",
            file=sys.stderr,
        )
        sys.exit(1)

    mp_face_mesh = mp.solutions.face_mesh
    face_mesh = mp_face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    positioner = HeadPositioner()
    last_emit = 0.0
    min_interval = 1.0 / args.fps if args.fps > 0 else 0.0

    while not stop_requested:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.01)
            continue

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = face_mesh.process(rgb)
        landmarks = None
        if result and result.multi_face_landmarks:
            landmarks = result.multi_face_landmarks[0].landmark

        payload = {
            "type": "head_position",
            "ts": time.time(),
        }
        payload.update(positioner.assess(landmarks))

        now = time.time()
        if args.jsonl and (now - last_emit >= min_interval):
            emit_json(payload)
            last_emit = now

    cap.release()
    try:
        cv2.destroyAllWindows()
    except Exception:
        pass


if __name__ == "__main__":
    main()
