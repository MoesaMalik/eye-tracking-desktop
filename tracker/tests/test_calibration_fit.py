import unittest
import numpy as np
import sys
from pathlib import Path

# Add the parent directory to sys.path so we can import from the tracker dir
sys.path.append(str(Path(__file__).parent.parent))
from calibration_fit import compute_norm, fit_affine, predict_affine

class TestCalibrationFit(unittest.TestCase):
    def test_compute_norm_standard(self):
        """Test standard normalization within eye box"""
        # Eye box: left=100, right=200 (width=100), top=50, bottom=100 (height=50)
        # Center: x=150, y=75 (dead center, should be 0.5, 0.5)
        nx, ny = compute_norm(150, 75, 100, 200, 50, 100)
        self.assertAlmostEqual(nx, 0.5)
        self.assertAlmostEqual(ny, 0.5)

    def test_compute_norm_clamping_min(self):
        """Test normalization clamps at NORM_CLAMP_MIN (-0.5)"""
        # Center far left/top of box
        nx, ny = compute_norm(0, 0, 100, 200, 50, 100)
        # 0 is -100 from left edge, width is 100 -> -1.0. Clamps to -0.5
        self.assertEqual(nx, -0.5)
        self.assertEqual(ny, -0.5)

    def test_compute_norm_clamping_max(self):
        """Test normalization clamps at NORM_CLAMP_MAX (1.5)"""
        # Center far right/bottom of box
        nx, ny = compute_norm(300, 150, 100, 200, 50, 100)
        # 300 is +100 from right edge, width is 100 -> 2.0. Clamps to 1.5
        self.assertEqual(nx, 1.5)
        self.assertEqual(ny, 1.5)

    def test_compute_norm_invalid(self):
        """Test normalization handles invalid inputs gracefully"""
        self.assertIsNone(compute_norm(None, 75, 100, 200, 50, 100))
        # Zero width/height box
        self.assertIsNone(compute_norm(150, 75, 100, 100, 50, 50))

    def test_fit_and_predict_affine(self):
        """Test affine mapping solves correctly for synthetic calibration points"""
        # Construct synthetic pairs mapping perfect normalized coordinates (0.0 to 1.0)
        # to a hypothetical 1920x1080 screen
        pairs = [
            # Top Left
            {"valid": True, "gaze_norm_avg": {"x": 0.0, "y": 0.0}, "target": {"x": 0, "y": 0}},
            # Top Right
            {"valid": True, "gaze_norm_avg": {"x": 1.0, "y": 0.0}, "target": {"x": 1920, "y": 0}},
            # Bottom Right
            {"valid": True, "gaze_norm_avg": {"x": 1.0, "y": 1.0}, "target": {"x": 1920, "y": 1080}},
            # Bottom Left
            {"valid": True, "gaze_norm_avg": {"x": 0.0, "y": 1.0}, "target": {"x": 0, "y": 1080}},
            # Center
            {"valid": True, "gaze_norm_avg": {"x": 0.5, "y": 0.5}, "target": {"x": 960, "y": 540}}
        ]

        # Fit the regression mapping
        cx, cy = fit_affine(pairs)
        
        # Test regressions against expected outputs
        # 1. Top left (0,0) -> Screen (0,0)
        sx, sy = predict_affine(cx, cy, 0.0, 0.0)
        self.assertAlmostEqual(sx, 0.0, places=1)
        self.assertAlmostEqual(sy, 0.0, places=1)

        # 2. Center (0.5,0.5) -> Screen (960,540)
        sx, sy = predict_affine(cx, cy, 0.5, 0.5)
        self.assertAlmostEqual(sx, 960.0, places=1)
        self.assertAlmostEqual(sy, 540.0, places=1)

    def test_fit_affine_insufficient_points(self):
        """Test fit_affine raises ValueError with less than 3 points"""
        pairs = [
            {"valid": True, "gaze_norm_avg": {"x": 0.0, "y": 0.0}, "target": {"x": 0, "y": 0}},
        ]
        with self.assertRaises(ValueError):
            fit_affine(pairs)

if __name__ == '__main__':
    unittest.main()
