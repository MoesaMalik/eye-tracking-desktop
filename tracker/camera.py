import cv2
import sys
from pathlib import Path
from datetime import datetime

def _open_cam(index: int):
    """
    Opens a video capture connection to the camera.
    Uses CAP_DSHOW on Windows for faster initialization.
    """
    if sys.platform.startswith("win"):
        return cv2.VideoCapture(index, cv2.CAP_DSHOW)
    return cv2.VideoCapture(index)


def _find_working_camera(preferred: int, search_range=6):
    """
    Attempts to find a working camera index.
    
    Args:
        preferred (int): The preferred camera index to try first.
        search_range (int): How many indices to search if the preferred one fails.
        
    Returns:
        tuple: (cv2.VideoCapture object or None, used_index or None)
    """
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
    """
    Attempts to lock camera auto-exposure and white balance to prevent 
    brightness/color fluctuations during recording. This is 'best-effort' 
    and may not work on all cameras/drivers.
    """
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


def record_video(camera_index, output_dir="recordings", show_preview=True):
    """
    Records video from the webcam to a file.
    
    Args:
        camera_index (int): The preferred camera index.
        output_dir (str): Directory where the recording will be saved.
        show_preview (bool): Whether to show a live preview window.
        
    Returns:
        tuple: (video_filename as str, fps as float)
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    session_dir = output_path / f"session_{timestamp}"
    session_dir.mkdir(parents=True, exist_ok=True)
    video_filename = session_dir / "recording.mp4"

    cap, used_idx = _find_working_camera(camera_index)
    if cap is None:
        raise RuntimeError(f"Camera not available at index {camera_index} (and no alternatives found).")

    _try_lock_camera_props(cap)

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
    fps = cap.get(cv2.CAP_PROP_FPS)
    # Validate FPS, default to 30 if invalid
    # Validate FPS, default to 30 if invalid or absurdly low
    if fps < 5 or fps > 120:
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

    def _make_writer(path, fps_val, size):
        for codec in ['avc1', 'H264', 'mp4v']:
            fourcc = cv2.VideoWriter_fourcc(*codec)
            writer = cv2.VideoWriter(str(path), fourcc, fps_val, size)
            if writer.isOpened():
                print(f"[INFO] Using codec {codec} for {path}")
                return writer
            writer.release()
        raise RuntimeError("Could not create VideoWriter with avc1/H264/mp4v")

    out = _make_writer(video_filename, fps, (width, height))

    frame_count = 0
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
