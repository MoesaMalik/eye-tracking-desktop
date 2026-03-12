# tracker/live_gaze_stream.py
"""
Live gaze streaming script for validation mode.
Outputs JSON-L format to stdout for real-time gaze tracking.
"""
import cv2
import mediapipe as mp
import json
import sys
import argparse
import time

try:
    from .geometry import iris_center_radius
    from .filter import OneEuroFilter
except (ImportError, ValueError):
    from geometry import iris_center_radius
    from filter import OneEuroFilter

LEFT_IRIS_IDX = [468, 469, 470, 471, 472]
RIGHT_IRIS_IDX = [473, 474, 475, 476, 477]

ONE_EURO_MIN_CUTOFF = 0.01
ONE_EURO_BETA = 0.005

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cam", type=int, default=0, help="Camera index")
    parser.add_argument("--fps", type=int, default=30, help="Target FPS")
    args = parser.parse_args()

    cap = cv2.VideoCapture(args.cam)
    if not cap.isOpened():
        print(json.dumps({"type": "error", "message": "Cannot open camera"}), flush=True)
        return

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    mp_face_mesh = mp.solutions.face_mesh
    face_mesh = mp_face_mesh.FaceMesh(
        static_image_mode=False,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    )

    filter_gx = None
    filter_gy = None
    
    frame_interval = 1.0 / args.fps
    next_frame_time = time.time()

    print(json.dumps({"type": "ready"}), flush=True)

    while True:
        now = time.time()
        if now < next_frame_time:
            time.sleep(0.001)
            continue
        
        next_frame_time = now + frame_interval

        ret, frame = cap.read()
        if not ret:
            break

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = face_mesh.process(rgb)

        gaze_data = {
            "type": "gaze",
            "timestamp": int(time.time() * 1000),
            "gaze_x": None,
            "gaze_y": None,
            "confidence": 0.0
        }

        if result and result.multi_face_landmarks:
            lms = result.multi_face_landmarks[0].landmark

            # Get iris centers from MediaPipe
            lcx, lcy, lr = iris_center_radius(lms, LEFT_IRIS_IDX, width, height)
            rcx, rcy, rr = iris_center_radius(lms, RIGHT_IRIS_IDX, width, height)

            # Average gaze position
            gx = (lcx + rcx) / 2.0
            gy = (lcy + rcy) / 2.0

            # Apply filtering
            if filter_gx is None:
                filter_gx = OneEuroFilter(now, gx, min_cutoff=ONE_EURO_MIN_CUTOFF, beta=ONE_EURO_BETA)
                filter_gy = OneEuroFilter(now, gy, min_cutoff=ONE_EURO_MIN_CUTOFF, beta=ONE_EURO_BETA)
            
            gx_filtered = filter_gx(now, gx)
            gy_filtered = filter_gy(now, gy)

            gaze_data["gaze_x"] = round(gx_filtered, 2)
            gaze_data["gaze_y"] = round(gy_filtered, 2)
            gaze_data["confidence"] = 1.0

        print(json.dumps(gaze_data), flush=True)

    cap.release()
    face_mesh.close()

if __name__ == "__main__":
    main()
