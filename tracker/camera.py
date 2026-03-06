import cv2
import sys
import time
import json
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


def _measure_delivered_fps(cap, num_frames=120, max_seconds=10):
    """
    Measures the actual delivered FPS by reading frames and timing them.
    Does NOT trust cap.get(CAP_PROP_FPS) which is unreliable on macOS.

    Args:
        cap: OpenCV VideoCapture object
        num_frames: Target number of frames to measure (default 120)
        max_seconds: Maximum time to spend measuring (default 10s)

    Returns:
        float: Measured FPS, or None if measurement failed
    """
    successful_reads = 0
    start_time = time.time()

    while successful_reads < num_frames:
        # Guard against hanging
        if time.time() - start_time > max_seconds:
            break

        ok, _ = cap.read()
        if ok:
            successful_reads += 1

    elapsed = time.time() - start_time

    if successful_reads < 10 or elapsed < 0.1:
        # Not enough data
        return None

    measured_fps = successful_reads / elapsed
    return measured_fps


def _select_best_fps(cap, candidates=None):
    """
    Auto-selects the highest FPS the camera can actually deliver.
    Tries candidate FPS values in descending order and measures actual delivery.

    Args:
        cap: OpenCV VideoCapture object
        candidates: List of FPS values to try (default [120, 60, 30, 24, 15])

    Returns:
        tuple: (chosen_fps, measured_fps)
    """
    if candidates is None:
        candidates = [120, 60, 30, 24, 15]

    print("\n[INFO] Auto-detecting best FPS...")
    best_measured = 0.0
    best_candidate = 30  # Fallback

    for candidate_fps in candidates:
        # Try to set this FPS
        cap.set(cv2.CAP_PROP_FPS, candidate_fps)

        # Warm-up: let auto-exposure settle (read and discard ~20 frames)
        for _ in range(20):
            cap.read()

        # Measure actual delivered FPS
        measured = _measure_delivered_fps(cap, num_frames=60, max_seconds=5)

        if measured is None:
            continue

        print(f"  Candidate {candidate_fps} fps → measured {measured:.1f} fps")

        # Use tolerance: 59.2 should count as "60-class"
        # Pick the candidate with highest measured fps
        if measured > best_measured:
            best_measured = measured
            best_candidate = candidate_fps

    print(f"[INFO] Selected: request {best_candidate} fps, delivers {best_measured:.1f} fps\n")

    # Set the best candidate one more time
    cap.set(cv2.CAP_PROP_FPS, best_candidate)

    # Return both the requested setting and the measured delivery
    return best_candidate, best_measured


def record_video(camera_index, output_dir="recordings", show_preview=True, stop_check=None):
    """
    Records video from the webcam to a file.
    
    Args:
        camera_index (int): The preferred camera index.
        output_dir (str): Directory where the recording will be saved.
        show_preview (bool): Whether to show a live preview window.
        stop_check (callable | None): Optional function to stop recording.
        
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

    # Auto-select the highest FPS the camera can actually deliver
    requested_fps, measured_fps = _select_best_fps(cap)

    # Clamp measured FPS to reasonable range (safety fallback)
    if measured_fps < 5 or measured_fps > 240:
        print(f"[WARNING] Measured FPS {measured_fps:.1f} is out of range, clamping to 30")
        measured_fps = 30.0

    # Use the measured FPS for all downstream operations
    fps = measured_fps

    # Get backend info if available
    backend_name = cap.getBackendName() if hasattr(cap, 'getBackendName') else "unknown"

    print(f"\n{'=' * 70}")
    print("CAMERA RECORDING")
    print(f"{'=' * 70}")
    print(f"Using camera index: {used_idx}")
    print(f"Backend: {backend_name}")
    print(f"Resolution: {width}x{height}")
    print(f"Requested FPS: {requested_fps}")
    print(f"Measured FPS: {measured_fps:.1f}")
    print(f"Using FPS: {fps:.1f}")

    # Warn if low FPS detected
    if fps < 25:
        print(f"\n{'!' * 70}")
        print(f"WARNING: Low FPS detected ({fps:.1f})")
        print(f"Timing metrics will quantize. Consider better lighting or camera settings.")
        print(f"{'!' * 70}")

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
    start_wall = time.time()

    while True:
        if stop_check and stop_check():
            stop_requested = True
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

    end_wall = time.time()
    wall_clock_duration = end_wall - start_wall

    cap.release()
    out.release()
    if show_preview:
        cv2.destroyAllWindows()

    # Compute real FPS from wall-clock timing
    real_fps = frame_count / wall_clock_duration if wall_clock_duration > 0 else fps
    # Clamp to reasonable range
    if real_fps < 1 or real_fps > 240:
        real_fps = fps

    # Re-encode video with correct FPS if there's a mismatch
    # This ensures playback speed matches recording speed
    if abs(real_fps - fps) > 1.0:
        print(f"\n[INFO] Writer FPS ({fps:.1f}) != Real FPS ({real_fps:.1f})")
        print(f"[INFO] Re-encoding video with correct FPS to fix playback speed...")

        temp_video = video_filename.with_suffix('.temp.mp4')
        video_filename.rename(temp_video)

        # Re-encode with correct FPS
        temp_cap = cv2.VideoCapture(str(temp_video))
        corrected_writer = _make_writer(video_filename, real_fps, (width, height))

        reencoded_frames = 0
        while True:
            ret, frame = temp_cap.read()
            if not ret:
                break
            corrected_writer.write(frame)
            reencoded_frames += 1

        temp_cap.release()
        corrected_writer.release()
        temp_video.unlink()  # Delete temp file
        print(f"[INFO] Re-encoded {reencoded_frames} frames with FPS: {real_fps:.1f}")

    # Save recording metadata so the tracker can use the correct FPS
    meta = {
        "frame_count": frame_count,
        "wall_clock_duration_sec": round(wall_clock_duration, 4),
        "real_fps": round(real_fps, 4),
        "writer_fps": real_fps,  # Updated to reflect re-encoded FPS
        "requested_fps": requested_fps,
        "measured_fps_burst": measured_fps,
        "resolution": [width, height],
    }
    meta_path = session_dir / "recording_meta.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)
    print(f"[OK] Saved recording metadata → {meta_path}")
    print(f"     Writer FPS: {real_fps:.1f}, Real FPS: {real_fps:.1f}, Wall-clock: {wall_clock_duration:.1f}s")

    print(f"\n[OK] Recording complete ({frame_count} frames)\n")
    return str(video_filename), real_fps
