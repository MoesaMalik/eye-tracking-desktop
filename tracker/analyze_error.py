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
    if video_path is None:
        video_path = _find_sample_video()
        if video_path is None:
            print("Error: No video found.")
            return

    print(f"Running analysis on: {video_path}")
    
    # Run tracker to generate data
    # We suppress the preview window for faster processing
    # Note: We need to ensure the output directory exists
    output_dir = Path("output")
    output_dir.mkdir(exist_ok=True)
    
    try:
        tracker = EyeTracker(video_path, output_dir="output")
        # We can suppress stdout to avoid clutter if desired, but seeing progress is good
        data = tracker.process_video()
    except Exception as e:
        print(f"Tracker failed: {e}")
        return

    # Load data into DataFrame
    df = pd.DataFrame(data)
    
    # Filter for frames where face was detected
    df_valid = df[df['face_detected'] == True].copy()
    
    if len(df_valid) == 0:
        print("No face detected in any frame.")
        return

    print("\n" + "="*50)
    print("EYE DETECTION ERROR ANALYSIS")
    print("="*50)
    
    # 1. Availability Analysis
    total_valid = len(df_valid)
    left_edge_count = df_valid['edge_left_cx'].notna().sum()
    right_edge_count = df_valid['edge_right_cx'].notna().sum()
    
    print(f"Total Frames with Face: {total_valid}")
    print(f"Left Eye Edge Detection Success: {left_edge_count}/{total_valid} ({left_edge_count/total_valid*100:.1f}%)")
    print(f"Right Eye Edge Detection Success: {right_edge_count}/{total_valid} ({right_edge_count/total_valid*100:.1f}%)")
    
    # 2. Deviation Analysis (Edge vs MediaPipe)
    # Calculate Euclidean distance between Edge center and MediaPipe center
    
    def calculate_deviation(row, side):
        if pd.isna(row[f'edge_{side}_cx']):
            return np.nan
        
        edge_pt = np.array([row[f'edge_{side}_cx'], row[f'edge_{side}_cy']])
        mp_pt = np.array([row[f'mp_{side}_cx'], row[f'mp_{side}_cy']])
        return np.linalg.norm(edge_pt - mp_pt)

    df_valid['left_deviation'] = df_valid.apply(lambda row: calculate_deviation(row, 'left'), axis=1)
    df_valid['right_deviation'] = df_valid.apply(lambda row: calculate_deviation(row, 'right'), axis=1)
    
    print("\nDeviation from MediaPipe Baseline (pixels):")
    print(f"Left Eye: Mean={df_valid['left_deviation'].mean():.2f}, Std={df_valid['left_deviation'].std():.2f}, Max={df_valid['left_deviation'].max():.2f}")
    print(f"Right Eye: Mean={df_valid['right_deviation'].mean():.2f}, Std={df_valid['right_deviation'].std():.2f}, Max={df_valid['right_deviation'].max():.2f}")
    
    # 3. Jitter Analysis (Stability)
    # Calculate standard deviation of gaze coordinates in a sliding window
    window_size = 5
    
    # We'll compute rolling std on the final used center coordinates
    df_valid['left_jitter'] = df_valid['left_center_x'].rolling(window=window_size).std() + df_valid['left_center_y'].rolling(window=window_size).std()
    df_valid['right_jitter'] = df_valid['right_center_x'].rolling(window=window_size).std() + df_valid['right_center_y'].rolling(window=window_size).std()
    
    # Compare jitter when using Edge vs MediaPipe
    # We can split the dataframe based on the method used
    
    print("\nStability Analysis (Jitter - Rolling Std Dev, window=5):")
    
    for side in ['left', 'right']:
        edge_frames = df_valid[df_valid[f'{side}_method'] == 'edge_band']
        mp_frames = df_valid[df_valid[f'{side}_method'] == 'iris_landmark_center']
        
        print(f"\n{side.capitalize()} Eye:")
        if len(edge_frames) > 0:
            edge_jitter = edge_frames[f'{side}_jitter'].mean()
            print(f"  Edge Method Jitter: {edge_jitter:.2f} px")
        else:
            print("  Edge Method: No data")
            
        if len(mp_frames) > 0:
            mp_jitter = mp_frames[f'{side}_jitter'].mean()
            print(f"  MediaPipe Method Jitter: {mp_jitter:.2f} px")
        else:
            print("  MediaPipe Method: No data")

    # Save detailed report
    report_path = output_dir / "error_analysis_report.csv"
    df_valid.to_csv(report_path, index=False)
    print(f"\nDetailed report saved to: {report_path}")

if __name__ == "__main__":
    analyze_error()
