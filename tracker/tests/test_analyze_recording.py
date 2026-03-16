import unittest
import numpy as np
import sys
from pathlib import Path

# Add the parent directory to sys.path so we can import from the tracker dir
sys.path.append(str(Path(__file__).parent.parent))

from analyze_recording import exponential_fit_function, detect_stimuli_changes, extract_signal_from_tracking

class TestAnalyzeRecording(unittest.TestCase):
    
    def test_exponential_fit_function(self):
        """Test exponential fitting math logic."""
        # Function: b * (1 - exp(-(t-d)/tau)) * (t>=d) + a
        
        # Test case 1: t < d (before delay), should just be 'a'
        val = exponential_fit_function(0.5, a=100.0, b=50.0, tau=0.1, d=1.0)
        self.assertAlmostEqual(val, 100.0)

        # Test case 2: t == d (at delay start), should still be exactly 'a'
        val = exponential_fit_function(1.0, a=100.0, b=50.0, tau=0.1, d=1.0)
        self.assertAlmostEqual(val, 100.0)

        # Test case 3: t >> d (long after delay), should approach 'a + b'
        val = exponential_fit_function(5.0, a=100.0, b=50.0, tau=0.1, d=1.0)
        self.assertAlmostEqual(val, 150.0, places=4)
        
    def test_detect_stimuli_changes(self):
        """Test transition extraction from JSON-like frame streams"""
        mock_frames = [
            {"frame": 0, "timestamp_sec": 0.0, "filename": "center.png", "slide_index": 0},
            {"frame": 1, "timestamp_sec": 0.5, "filename": "center.png", "slide_index": 0},
            # Change happens here: center -> target1
            {"frame": 2, "timestamp_sec": 1.0, "filename": "target_left.png", "slide_index": 1},
            {"frame": 3, "timestamp_sec": 1.5, "filename": "target_left.png", "slide_index": 1},
            # Change happens here: target1 -> center
            {"frame": 4, "timestamp_sec": 2.0, "filename": "center.png", "slide_index": 2},
            {"frame": 5, "timestamp_sec": 2.5, "filename": "center.png", "slide_index": 2},
        ]
        
        res = detect_stimuli_changes(mock_frames)
        
        # We expect 2 changes: center->left (start recording), left->center
        self.assertEqual(res['num_changes'], 2)
        self.assertEqual(res['event_times'], [1.0, 2.0])
        self.assertEqual(res['event_frames'], [2, 4])
        
        # Verify transition metadata
        self.assertEqual(res['stimuli_info'][0]['from_filename'], "center.png")
        self.assertEqual(res['stimuli_info'][0]['to_filename'], "target_left.png")
        self.assertEqual(res['stimuli_info'][1]['from_filename'], "target_left.png")
        self.assertEqual(res['stimuli_info'][1]['to_filename'], "center.png")

    def test_extract_signal_from_tracking_raw(self):
        """Test signal extraction and blink handling with no smoothing"""
        mock_frames = [
            # T=0: Valid gaze
            {"timestamp_sec": 0.0, "is_blink": False, "gaze_x_raw": 100.0},
            # T=1: Blink frame, but we provide a gaze_x_raw so it doesn't trigger the "missing data" continue fallback
            {"timestamp_sec": 1.0, "is_blink": True, "gaze_x_raw": 0.0},
            # T=2: Another blink frame, should still hold (100.0)
            {"timestamp_sec": 2.0, "is_blink": True, "gaze_x_raw": 55.0},
            # T=3: Valid gaze resumes
            {"timestamp_sec": 3.0, "is_blink": False, "gaze_x_raw": 200.0},
        ]
        
        time, signal, name = extract_signal_from_tracking(mock_frames, signal_type='gaze_x', filter_level='raw')
        
        self.assertEqual(len(time), 4)
        np.testing.assert_array_equal(time, [0.0, 1.0, 2.0, 3.0])
        self.assertEqual(name, 'Gaze X (horizontal)')
        
        # Remember extract_signal_from_tracking centers the signal around the mean!
        # Values: [100.0, 100.0, 100.0, 200.0], Mean = 125.0
        # Centered: [-25.0, -25.0, -25.0, 75.0]
        np.testing.assert_array_almost_equal(signal, [-25.0, -25.0, -25.0, 75.0])


if __name__ == '__main__':
    unittest.main()
