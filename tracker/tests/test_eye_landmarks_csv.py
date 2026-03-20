"""
Tests for write_eye_landmarks_csv and EYE_LANDMARK_COLUMNS in tracker/main.py.
"""
import csv
import math
import sys
import tempfile
import unittest
from pathlib import Path

# Make the tracker package importable when run directly
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from tracker.main import EYE_LANDMARK_COLUMNS, write_eye_landmarks_csv


def _make_frame(frame=0, ts=0.0, **kwargs):
    """Build a minimal frame dict with sensible defaults."""
    base = {
        "frame": frame,
        "timestamp_sec": ts,
        "left_eye_left_x": 775.23,
        "left_eye_right_x": 905.57,
        "left_eye_top_x": 829.57,
        "left_eye_top_y": 310.12,
        "left_eye_bottom_x": 831.00,
        "left_eye_bottom_y": 360.45,
        "right_eye_left_x": 200.10,
        "right_eye_right_x": 330.88,
        "right_eye_top_x": 265.44,
        "right_eye_top_y": 308.99,
        "right_eye_bottom_x": 266.00,
        "right_eye_bottom_y": 358.22,
        "left_mp_x": 840.11,
        "left_mp_y": 335.50,
        "right_mp_x": 265.00,
        "right_mp_y": 333.75,
        "left_center_x": 840.50,
        "left_center_y": 336.00,
        "right_center_x": 265.50,
        "right_center_y": 334.00,
        "gaze_x": 553.00,
        "gaze_y": 335.00,
        "is_blink": False,
    }
    base.update(kwargs)
    return base


class TestEyeLandmarkColumns(unittest.TestCase):

    def test_required_columns_present(self):
        """EYE_LANDMARK_COLUMNS"""
        required = [
            "left_eye_left_x",
            "left_eye_right_x",
            "left_eye_top_x",
            "left_eye_top_y",
            "left_eye_bottom_x",
            "left_eye_bottom_y",
            "right_eye_left_x",
            "right_eye_right_x",
        ]
        for col in required:
            self.assertIn(col, EYE_LANDMARK_COLUMNS, f"Missing required column: {col}")

    def test_frame_and_timestamp_first(self):
        """frame and timestamp_sec should be the first two columns."""
        self.assertEqual(EYE_LANDMARK_COLUMNS[0], "frame")
        self.assertEqual(EYE_LANDMARK_COLUMNS[1], "timestamp_sec")


class TestWriteEyeLandmarksCsv(unittest.TestCase):

    def _write_and_read(self, tracking_data):
        """Helper: write CSV to a temp file and return parsed rows."""
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w") as tmp:
            tmp_path = Path(tmp.name)
        write_eye_landmarks_csv(tracking_data, tmp_path)
        with open(tmp_path, newline="") as f:
            rows = list(csv.reader(f))
        tmp_path.unlink()
        return rows

    def test_header_row_matches_columns(self):
        """First row must be exactly EYE_LANDMARK_COLUMNS."""
        rows = self._write_and_read([_make_frame()])
        self.assertEqual(rows[0], EYE_LANDMARK_COLUMNS)

    def test_data_row_count(self):
        """One data row per frame plus the header."""
        frames = [_make_frame(i, float(i)) for i in range(5)]
        rows = self._write_and_read(frames)
        self.assertEqual(len(rows), 6)  # 1 header + 5 data

    def test_numeric_values_written_correctly(self):
        """Numeric values should round-trip correctly."""
        rows = self._write_and_read([_make_frame()])
        col_idx = EYE_LANDMARK_COLUMNS.index("left_eye_left_x")
        self.assertAlmostEqual(float(rows[1][col_idx]), 775.23, places=2)

    def test_nan_written_as_empty_string(self):
        """NaN must become an empty cell for Excel compatibility."""
        frame = _make_frame(left_eye_left_x=float("nan"))
        rows = self._write_and_read([frame])
        col_idx = EYE_LANDMARK_COLUMNS.index("left_eye_left_x")
        self.assertEqual(rows[1][col_idx], "")

    def test_inf_written_as_empty_string(self):
        """Inf must become an empty cell."""
        frame = _make_frame(left_eye_right_x=float("inf"))
        rows = self._write_and_read([frame])
        col_idx = EYE_LANDMARK_COLUMNS.index("left_eye_right_x")
        self.assertEqual(rows[1][col_idx], "")

    def test_missing_key_written_as_empty_string(self):
        """Missing keys (None from .get()) must become empty cells."""
        frame = _make_frame()
        del frame["gaze_x"]
        rows = self._write_and_read([frame])
        col_idx = EYE_LANDMARK_COLUMNS.index("gaze_x")
        self.assertEqual(rows[1][col_idx], "")

    def test_creates_file_at_given_path(self):
        """File must be created at the specified path."""
        with tempfile.TemporaryDirectory() as tmpdir:
            out = Path(tmpdir) / "test_output.csv"
            write_eye_landmarks_csv([_make_frame()], out)
            self.assertTrue(out.exists())

    def test_empty_tracking_data(self):
        """Empty input produces a header-only CSV (no crash)."""
        rows = self._write_and_read([])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], EYE_LANDMARK_COLUMNS)


if __name__ == "__main__":
    unittest.main()
