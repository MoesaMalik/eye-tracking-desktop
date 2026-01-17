import sys
import os
import pytest
from unittest.mock import MagicMock

# Add parent directory to path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from head_positioning import HeadPositioner, LANDMARK_LEFT_EYE, LANDMARK_RIGHT_EYE, LANDMARK_NOSE_TIP, LANDMARK_MOUTH

# Helper to create mock landmarks
def create_mock_landmarks(lx, ly, rx, ry, nx, ny, mx, my):
    # We only need specific indices to be accessible
    landmarks = MagicMock()
    
    def get_landmark(idx):
        if idx == LANDMARK_LEFT_EYE: return MagicMock(x=lx, y=ly)
        if idx == LANDMARK_RIGHT_EYE: return MagicMock(x=rx, y=ry)
        if idx == LANDMARK_NOSE_TIP: return MagicMock(x=nx, y=ny)
        if idx == LANDMARK_MOUTH: return MagicMock(x=mx, y=my)
        return MagicMock(x=0, y=0)
    
    landmarks.__getitem__.side_effect = get_landmark
    return landmarks

def test_assess_no_face():
    """Test that assess returns correct status when no landmarks provided."""
    hp = HeadPositioner()
    result = hp.assess(None)
    assert result['status'] == 'NOT_DETECTED'
    assert result['instruction'] == 'Face not detected'
    assert result['progress'] == 0.0

def test_assess_misaligned_move_right():
    """Test alignment instruction when face is too far left."""
    hp = HeadPositioner(target_x=(0.4, 0.6))
    
    # Create face centered at x=0.2 (too left)
    # y=0.5 (good), size ok (~0.2 width)
    lms = create_mock_landmarks(
        lx=0.15, ly=0.5, rx=0.25, ry=0.5, # eyes
        nx=0.2, ny=0.5,                   # nose
        mx=0.2, my=0.6                    # mouth
    )
    
    result = hp.assess(lms)
    assert result['status'] == 'ALIGNING'
    assert 'Move right' in result['instruction']

def test_assess_misaligned_move_closer():
    """Test alignment instruction when face is too small (far away)."""
    hp = HeadPositioner(size_range=(0.2, 0.3))
    
    # Face width = 0.05 (too small)
    lms = create_mock_landmarks(
        lx=0.475, ly=0.5, rx=0.525, ry=0.5, 
        nx=0.5, ny=0.5, mx=0.5, my=0.6
    )
    
    result = hp.assess(lms)
    assert result['status'] == 'ALIGNING'
    assert 'Move closer' in result['instruction']

def test_assess_stabilizing_to_ready():
    """Test the transition from STABILIZING to READY when holding still."""
    hp = HeadPositioner(window=5, center_delta=0.05, size_delta=0.05)
    
    # Perfect postion: center ~0.5, width ~0.25
    lms_base = {
        'lx': 0.375, 'ly': 0.5, 'rx': 0.625, 'ry': 0.5,
        'nx': 0.5, 'ny': 0.5, 'mx': 0.5, 'my': 0.6
    }
    
    lms = create_mock_landmarks(**lms_base)
    
    # First frame: aligned, but history empty -> starts stabilizing
    result = hp.assess(lms)
    assert result['status'] == 'STABILIZING'
    assert result['progress'] < 1.0
    
    # Hold still for 'window' frames
    # We iterate 4 more times to reach window=5
    for i in range(4):
        # reuse same landmarks (perfectly still)
        result = hp.assess(lms)
    
    # Now should be ready
    assert result['status'] == 'READY'
    assert result['progress'] == 1.0
    assert result['instruction'] == 'Good position'

def test_reset_on_movement():
    """Test that movement resets the stability counter."""
    hp = HeadPositioner(window=5, center_delta=0.01) # strict delta
    
    # Frame 1: Position A
    lms_a = create_mock_landmarks(0.375, 0.5, 0.625, 0.5, 0.5, 0.5, 0.5, 0.6)
    hp.assess(lms_a)
    assert hp.stable_count == 1
    
    # Frame 2: Position B (Moved significantly)
    lms_b = create_mock_landmarks(0.475, 0.5, 0.725, 0.5, 0.6, 0.5, 0.6, 0.6)
    hp.assess(lms_b)
    
    # Should have reset stability because delta exceeded
    assert hp.stable_count == 0 
