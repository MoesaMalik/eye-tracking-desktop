import sys
import os
import math
import pytest

# Add parent directory to path to allow importing modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from filter import OneEuroFilter

def test_initialization():
    """Test that the filter initializes with correct values."""
    f = OneEuroFilter(t0=0, x0=0)
    assert f.x_prev == 0
    assert f.t_prev == 0
    assert f.dx_prev == 0.0

def test_constant_signal():
    """Test that a constant signal remains constant through the filter."""
    f = OneEuroFilter(t0=0, x0=10, min_cutoff=1.0, beta=0.0)
    # Feed constant value
    out = f(t=1, x=10)
    assert math.isclose(out, 10.0, rel_tol=1e-9)
    out = f(t=2, x=10)
    assert math.isclose(out, 10.0, rel_tol=1e-9)

def test_step_response_lag():
    """Test that the filter exhibits lag (smoothing) for a step input."""
    # Start at 0
    f = OneEuroFilter(t0=0, x0=0, min_cutoff=0.1, beta=0.0)
    
    # Jump to 10 at t=1
    # Low cutoff frequency means heavy smoothing -> significant lag
    out = f(t=1, x=10)
    
    # Output should be between 0 and 10, not immediately 10
    assert 0 < out < 10
    
    # After more time, it should approach 10
    for i in range(2, 11):
        out = f(t=i, x=10)
    
    # Should be closer to 10 now
    assert out > 5

def test_high_speed_coefficient():
    """Test that high beta reduces lag during fast movement."""
    # Low min_cutoff for static smoothing, high beta for dynamic response
    f = OneEuroFilter(t0=0, x0=0, min_cutoff=0.01, beta=100.0)
    
    # Rapid change
    out = f(t=1, x=100)
    
    # High beta means cutoff increases with speed (derivative), so it should track faster
    # than if beta was 0.
    
    f_slow = OneEuroFilter(t0=0, x0=0, min_cutoff=0.01, beta=0.0)
    out_slow = f_slow(t=1, x=100)
    
    assert out > out_slow
