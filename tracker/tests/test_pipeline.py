import sys
import os
import cv2
import pytest
import tempfile
import numpy as np
from pathlib import Path

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import EyeTracker

@pytest.fixture
def dummy_video_path():
    """Creates a temporary dummy video file for testing."""
    # Create a temp file
    fd, path = tempfile.mkstemp(suffix='.mp4')
    os.close(fd)
    
    # Generate 1 second of video (30 frames)
    # 640x480 resolution, white noise
    width, height = 640, 480
    fps = 30
    duration_sec = 1
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(path, fourcc, fps, (width, height))
    
    for _ in range(fps * duration_sec):
        # Create a random noise frame
        frame = np.random.randint(0, 255, (height, width, 3), dtype=np.uint8)
        out.write(frame)
        
    out.release()
    
    yield path
    
    # Cleanup
    if os.path.exists(path):
        os.remove(path)

def test_pipeline_smoke_test(dummy_video_path):
    """
    Smoke verify that EyeTracker can load a video and run process_video 
    without crashing.
    """
    # Create a temporary output directory
    with tempfile.TemporaryDirectory() as temp_out_dir:
        tracker = EyeTracker(dummy_video_path, output_dir=temp_out_dir)
        
        # Determine strictness: 
        # Since it's random noise, face_mesh might not detect anything. 
        # That's fine. We just want to ensure the LOOP runs and finishes.
        
        results = tracker.process_video()
        
        # Check that we got a result list (should be 30 frames)
        assert isinstance(results, list)
        assert len(results) == 30
        
        # Verify output files were created
        # The code creates: filename_tracked.mp4, filename_tracking_data.csv, .json
        stem = Path(dummy_video_path).stem
        
        # We expect the CSV and JSON to exist
        expected_csv = Path(temp_out_dir) / f"{stem}_tracking_data.csv"
        expected_json = Path(temp_out_dir) / f"{stem}_tracking_data.json"
        
        assert expected_csv.exists()
        assert expected_json.exists()
        
        # Additional check: Ensure frames have basic keys even if face not detected
        first_frame = results[0]
        assert 'frame' in first_frame
        assert 'timestamp_sec' in first_frame
        assert 'face_detected' in first_frame
