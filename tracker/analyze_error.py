import pandas as pd
import numpy as np
import json
from pathlib import Path
import sys
import os

# Add parent directory to path to import tracker modules if needed
sys.path.append(str(Path(__file__).parent.parent))

from tracker.main import EyeTracker, _find_sample_video

def analyze_error(video_path=None):
    """
    Analyzes the error of the eye tracking algorithm by comparing it with a reference (MediaPipe).
    
    It performs three types of analysis:
    1. Availability: Percentage of frames where eye edges were successfully detected.
    2. Deviation: Euclidean distance between the calculated iris center (using edge detection) 
       and the reference center (MediaPipe iris landmarks).
    3. Jitter: Stability of the gaze coordinates over time (sliding window standard deviation).
    
    Args:
        video_path (str or Path, optional): Path to the video file to analyze. 
                                            If None, tries to find a sample video.
    """
    if video_path is None:
        video_path = _find_sample_video()
        if video_path is None:
            print("Error: No video found.")
            return

    print(f"Running analysis on: {video_path}")
    
    # Run tracker to generate data
    # We suppress the preview window for faster processing based on assumption, 
    # but the EyeTracker class might show it unless configured otherwise.
    # Note: We need to ensure the output directory exists
    output_dir = Path("output")
    output_dir.mkdir(exist_ok=True)
    
    try:
        tracker = EyeTracker(video_path, output_dir="output")
        # Process the video to get tracking data.
        # This will run the full tracking pipeline: face mesh, iris detection, edge refinement, etc.
        data = tracker.process_video()
    except Exception as e:
        print(f"Tracker failed: {e}")
        return

    # Load data into DataFrame for easier analysis
    df = pd.DataFrame(data)
    
    # Filter for frames where face was detected
    # We only care about frames where we actually attempted to find eyes.
    df_valid = df[df['face_detected'] == True].copy()
    
    if len(df_valid) == 0:
        print("No face detected in any frame.")
        return

    print("\n" + "="*50)
    print("EYE DETECTION ERROR ANALYSIS")
    print("="*50)
    
    # 1. Availability Analysis
    # Check how often our custom edge detection algorithms (Circle or Ellipse fit)
    # successfully returned a result (i.e., method is not the fallback 'iris_landmark_center' or 'blink').
    # Note: New tracker uses 'ellipse_fit...' or 'circle_fit...' or 'iris_landmark_center' or 'blink'.
    
    def is_edge_method(method_str):
        if not isinstance(method_str, str): return False
        return 'fit' in method_str

    total_valid = len(df_valid)
    left_edge_count = df_valid['left_method'].apply(is_edge_method).sum()
    right_edge_count = df_valid['right_method'].apply(is_edge_method).sum()
    
    print(f"Total Frames with Face: {total_valid}")
    print(f"Left Eye Edge Detection Success: {left_edge_count}/{total_valid} ({left_edge_count/total_valid*100:.1f}%)")
    print(f"Right Eye Edge Detection Success: {right_edge_count}/{total_valid} ({right_edge_count/total_valid*100:.1f}%)")
    
    # 2. Deviation Analysis (Edge vs MediaPipe)
    # Calculate Euclidean distance between our Final Result (if edge-based) and MediaPipe rough center.
    
    def calculate_deviation(row, side):
        """
        Calculates Euclidean distance between final center (if edge-based) and MediaPipe center.
        """
        method = str(row[f'{side}_method'])
        if 'fit' not in method:
            return np.nan
            
        final_x = row[f'{side}_center_x']
        final_y = row[f'{side}_center_y']
        mp_x = row[f'{side}_mp_x']
        mp_y = row[f'{side}_mp_y']
        
        if pd.isna(final_x) or pd.isna(mp_x):
            return np.nan
        
        return np.linalg.norm(np.array([final_x, final_y]) - np.array([mp_x, mp_y]))

    df_valid['left_deviation'] = df_valid.apply(lambda row: calculate_deviation(row, 'left'), axis=1)
    df_valid['right_deviation'] = df_valid.apply(lambda row: calculate_deviation(row, 'right'), axis=1)
    
    print("\nDeviation from MediaPipe Baseline (pixels):")
    print(f"Left Eye: Mean={df_valid['left_deviation'].mean():.2f}, Std={df_valid['left_deviation'].std():.2f}, Max={df_valid['left_deviation'].max():.2f}")
    print(f"Right Eye: Mean={df_valid['right_deviation'].mean():.2f}, Std={df_valid['right_deviation'].std():.2f}, Max={df_valid['right_deviation'].max():.2f}")
    
    # 3. Jitter Analysis (Stability)
    # Calculate standard deviation of gaze coordinates in a sliding window.
    # Lower jitter means the eye tracking is more stable (less noise).
    window_size = 5
    
    # We'll compute rolling std on the final used center coordinates
    df_valid['left_jitter'] = df_valid['left_center_x'].rolling(window=window_size).std() + df_valid['left_center_y'].rolling(window=window_size).std()
    df_valid['right_jitter'] = df_valid['right_center_x'].rolling(window=window_size).std() + df_valid['right_center_y'].rolling(window=window_size).std()
    
    # Compare jitter when using Edge-based method vs MediaPipe-based method
    print("\nStability Analysis (Jitter - Rolling Std Dev, window=5):")
    
    for side in ['left', 'right']:
        # Filter frames where our custom edge band method was used
        edge_frames = df_valid[df_valid[f'{side}_method'].astype(str).str.contains('fit')]
        # Filter frames where we fell back to MediaPipe iris landmarks (and no smoothing? actually main.py uses smoothing for MP too now)
        mp_frames = df_valid[df_valid[f'{side}_method'] == 'iris_landmark_center']
        
        print(f"\n{side.capitalize()} Eye:")
        if len(edge_frames) > 0:
            edge_jitter = edge_frames[f'{side}_jitter'].mean()
            print(f"  Edge Fit Methods Jitter: {edge_jitter:.2f} px")
        else:
            print("  Edge Fit Methods: No data")
            
        if len(mp_frames) > 0:
            mp_jitter = mp_frames[f'{side}_jitter'].mean()
            print(f"  MediaPipe Fallback Jitter: {mp_jitter:.2f} px")
        else:
            print("  MediaPipe Fallback: No data")

    # Save detailed report
    report_path = output_dir / "error_analysis_report.csv"
    df_valid.to_csv(report_path, index=False)
    print(f"\nDetailed report saved to: {report_path}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        analyze_error(sys.argv[1])
    else:
        analyze_error()
