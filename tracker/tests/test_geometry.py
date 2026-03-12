import sys
import os
import math
import numpy as np
import pytest

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from geometry import calculate_ear, _taubin_circle_fit

# Mock Landmark class to simulate MediaPipe landmarks
class MockLandmark:
    def __init__(self, x, y):
        self.x = x
        self.y = y

def test_calculate_ear_open_eye():
    """Test EAR calculation for a wide open eye (should be high, ~0.3)."""
    # Create a simplified rectangle eye: width 100, height 30
    # EAR = (30 + 30) / (2 * 100) = 60 / 200 = 0.3
    w, h = 1000, 1000
    
    # Indices are arbitrary here because we pass the list manually
    # But calculate_ear expects them in order p1..p6
    
    # p1 (left corner) at (0.1, 0.5)
    # p4 (right corner) at (0.2, 0.5) -> width = 0.1 * 1000 = 100px
    landmarks = {
        0: MockLandmark(0.1, 0.5),      # p1
        1: MockLandmark(0.13, 0.47),    # p2 (top-left)
        2: MockLandmark(0.17, 0.47),    # p3 (top-right)
        3: MockLandmark(0.2, 0.5),      # p4
        4: MockLandmark(0.17, 0.53),    # p5 (bottom-right)
        5: MockLandmark(0.13, 0.53)     # p6 (bottom-left)
    }
    
    # Height of eye roughly (0.53 - 0.47) * 1000 = 0.06 * 1000 = 60px
    # v1 = dist(p2, p6) = 60
    # v2 = dist(p3, p5) = 60
    # hor = dist(p1, p4) = 100
    # EAR = (60+60)/(2*100) = 0.6 -- wait, my math above: (0.53-0.47)=0.06. 
    # Let's trust the function.
    
    idx_list = [0, 1, 2, 3, 4, 5]
    ear = calculate_ear(landmarks, idx_list, w, h)
    
    assert math.isclose(ear, 0.6, rel_tol=1e-5)

def test_calculate_ear_closed_eye():
    """Test EAR calculation for a closed eye (should be near 0)."""
    w, h = 1000, 1000
    
    # All y's same = closed
    landmarks = {
        0: MockLandmark(0.1, 0.5),
        1: MockLandmark(0.13, 0.5),
        2: MockLandmark(0.17, 0.5),
        3: MockLandmark(0.2, 0.5),
        4: MockLandmark(0.17, 0.5),
        5: MockLandmark(0.13, 0.5)
    }
    
    idx_list = [0, 1, 2, 3, 4, 5]
    ear = calculate_ear(landmarks, idx_list, w, h)
    
    assert ear == 0.0

def test_taubin_circle_fit_perfect():
    """Test circle fitting on perfect circle points."""
    # Circle at (10, 10) with radius 5
    # Points: (15, 10), (5, 10), (10, 15), (10, 5)
    cx_true, cy_true, r_true = 10.0, 10.0, 5.0
    
    # Generate points around circle
    angles = np.linspace(0, 2*np.pi, 8, endpoint=False)
    x = cx_true + r_true * np.cos(angles)
    y = cy_true + r_true * np.sin(angles)
    
    fit = _taubin_circle_fit(x, y)
    assert fit is not None
    cx, cy, r = fit
    
    assert math.isclose(cx, cx_true, abs_tol=1e-5)
    assert math.isclose(cy, cy_true, abs_tol=1e-5)
    assert math.isclose(r, r_true, abs_tol=1e-5)

def test_taubin_circle_fit_noise():
    """Test circle fitting with slight noise."""
    cx_true, cy_true, r_true = 50.0, 50.0, 20.0
    
    angles = np.linspace(0, 2*np.pi, 20, endpoint=False)
    x = cx_true + r_true * np.cos(angles)
    y = cy_true + r_true * np.sin(angles)
    
    # Add tiny noise
    x[0] += 0.1
    y[5] -= 0.1
    
    fit = _taubin_circle_fit(x, y)
    assert fit is not None
    cx, cy, r = fit
    
    # Should still be very close
    assert math.isclose(cx, cx_true, abs_tol=0.5)
    assert math.isclose(cy, cy_true, abs_tol=0.5)
    assert math.isclose(r, r_true, abs_tol=0.5)
