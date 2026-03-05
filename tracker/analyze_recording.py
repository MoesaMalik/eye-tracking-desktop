"""
Eye-tracking recording data analysis script.
Reads tracking JSON files, performs exponential curve fitting on eye movement signals.
"""

import sys
import json
import numpy as np
from scipy.optimize import curve_fit
from scipy.signal import find_peaks
from pathlib import Path


def exponential_fit_function(t, a, b, tau, d):
    """
    Exponential fitting function: b*(1 - exp(-(t-d)/tau))*(t>=d) + a

    Parameters:
    - a: baseline offset
    - b: amplitude
    - tau: time constant
    - d: delay/onset time
    """
    return b * (1 - np.exp(-(t - d) / tau)) * (t >= d) + a


def calculate_fit_error(t, signal, lim_before, lim_after):
    """Calculate mean absolute error in a time range."""
    idx = np.logical_and(t >= lim_before, t <= lim_after)
    signal_segment = signal[idx]
    if len(signal_segment) == 0:
        return 0.0
    return float(np.mean(np.abs(signal_segment)))


def detect_events(signal, time, threshold_factor=2.0, min_distance=30):
    """
    Detect eye movement events (saccades) in the signal using peak detection.

    Args:
        signal: Signal array
        time: Time array
        threshold_factor: Multiplier for std to set peak detection threshold
        min_distance: Minimum distance between peaks (in frames)

    Returns:
        List of event times (in seconds)
    """
    # Calculate velocity (first derivative)
    velocity = np.diff(signal)
    velocity = np.concatenate([[0], velocity])  # Pad to match length

    # Calculate threshold based on velocity std
    threshold = threshold_factor * np.std(np.abs(velocity))

    # Find peaks in absolute velocity
    peaks, properties = find_peaks(
        np.abs(velocity),
        height=threshold,
        distance=min_distance
    )

    # Return peak times
    event_times = time[peaks] if len(peaks) > 0 else np.array([])

    return event_times.tolist()


def extract_signal_from_tracking(frames, signal_type='gaze_x'):
    """
    Extract a signal from tracking frames.

    Args:
        frames: List of tracking frame dictionaries
        signal_type: Type of signal to extract. Options:
            - 'gaze_x', 'gaze_y': Gaze position (average of left and right eyes)
            - 'left_x', 'left_y': Left eye position
            - 'right_x', 'right_y': Right eye position
            - 'left_mp_x', 'left_mp_y': Left eye midpoint
            - 'right_mp_x', 'right_mp_y': Right eye midpoint

    Returns:
        tuple: (time_array, signal_array, signal_name)
    """
    time = []
    signal = []

    for frame in frames:
        t = frame.get('timestamp_sec')
        if t is None:
            continue

        # Extract signal based on type
        if signal_type == 'gaze_x':
            left_x = frame.get('left_mp_x')
            right_x = frame.get('right_mp_x')
            if left_x is not None and right_x is not None:
                value = (left_x + right_x) / 2
            elif left_x is not None:
                value = left_x
            elif right_x is not None:
                value = right_x
            else:
                continue
        elif signal_type == 'gaze_y':
            left_y = frame.get('left_mp_y')
            right_y = frame.get('right_mp_y')
            if left_y is not None and right_y is not None:
                value = (left_y + right_y) / 2
            elif left_y is not None:
                value = left_y
            elif right_y is not None:
                value = right_y
            else:
                continue
        elif signal_type == 'left_x':
            value = frame.get('left_mp_x')
        elif signal_type == 'left_y':
            value = frame.get('left_mp_y')
        elif signal_type == 'right_x':
            value = frame.get('right_mp_x')
        elif signal_type == 'right_y':
            value = frame.get('right_mp_y')
        else:
            # Direct key lookup
            value = frame.get(signal_type)

        if value is None:
            continue

        time.append(t)
        signal.append(value)

    time = np.array(time)
    signal = np.array(signal)

    # Subtract mean to center signal
    if len(signal) > 0:
        signal = signal - np.mean(signal)

    signal_names = {
        'gaze_x': 'Gaze X (horizontal)',
        'gaze_y': 'Gaze Y (vertical)',
        'left_x': 'Left Eye X',
        'left_y': 'Left Eye Y',
        'right_x': 'Right Eye X',
        'right_y': 'Right Eye Y',
    }
    signal_name = signal_names.get(signal_type, signal_type)

    return time, signal, signal_name


def read_tracking_data(file_path, signal_type='gaze_x'):
    """
    Read tracking data from JSON file and extract signal.

    Args:
        file_path: Path to tracking JSON file
        signal_type: Type of signal to extract

    Returns:
        dict with time, signal, and metadata
    """
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)

        frames = data.get('frames', [])
        if not frames:
            return {"error": "No frames found in tracking data"}

        time, signal, signal_name = extract_signal_from_tracking(frames, signal_type)

        if len(time) == 0:
            return {"error": f"No valid {signal_type} data found in tracking"}

        max_time = float(np.max(time))

        return {
            "time": time.tolist(),
            "signal": signal.tolist(),
            "signal_name": signal_name,
            "max_time": max_time,
            "num_frames": len(frames),
            "num_valid": len(time)
        }

    except Exception as e:
        return {"error": str(e)}


def fit_parameters(time, signal, event_times, before_lim, after_lim):
    """
    Fit exponential curves to eye-tracking events.

    Args:
        time: Time array
        signal: Signal array
        event_times: List of event times (in seconds)
        before_lim: Time before event to include (seconds)
        after_lim: Time after event to include (seconds)

    Returns:
        dict: Fitted parameters for each event
    """
    try:
        t = np.array(time)
        x = np.array(signal)

        if len(event_times) == 0:
            return {"error": "No events to fit"}

        # Fitting bounds: [a_min, b_min, tau_min, d_min], [a_max, b_max, tau_max, d_max]
        bounds = ([-2000, -2000, 0.001, -0.6], [2000, 2000, 5, 0.6])

        results = []

        for i, event_time in enumerate(event_times):
            # Select data window around event
            idx = (t - event_time > -before_lim) & (t - event_time < after_lim)
            t_fit = t[idx] - event_time
            s_fit = x[idx]

            if len(t_fit) < 4:  # Need at least 4 points to fit
                results.append({
                    "index": int(i),
                    "event_time": float(event_time),
                    "error": "Insufficient data points"
                })
                continue

            try:
                # Perform curve fitting
                popt, pcov = curve_fit(exponential_fit_function, t_fit, s_fit, bounds=bounds)

                # Calculate fitted signal
                s_fitted = exponential_fit_function(t_fit, *popt)
                fit_diff = s_fit - s_fitted

                # Calculate fit errors in different time windows relative to delay
                d = popt[3]  # delay parameter
                t_fit_zeroed = t_fit - d

                fitb = calculate_fit_error(t_fit_zeroed, fit_diff, -0.5, 0)     # Before
                fitd = calculate_fit_error(t_fit_zeroed, fit_diff, 0, 0.5)      # During
                fita = calculate_fit_error(t_fit_zeroed, fit_diff, 0.5, 1.0)    # After

                results.append({
                    "index": int(i),
                    "event_time": float(event_time),
                    "a": float(popt[0]),
                    "b": float(popt[1]),
                    "tau": float(popt[2]),
                    "d": float(popt[3]),
                    "fit_before": float(fitb),
                    "fit_during": float(fitd),
                    "fit_after": float(fita),
                    "t_fit": t_fit.tolist(),
                    "s_original": s_fit.tolist(),
                    "s_fitted": s_fitted.tolist()
                })

            except Exception as e:
                results.append({
                    "index": int(i),
                    "event_time": float(event_time),
                    "error": str(e)
                })

        return {"results": results}

    except Exception as e:
        return {"error": str(e)}


def auto_detect_and_fit(time, signal, before_lim, after_lim, threshold_factor=2.0, min_distance=30):
    """
    Automatically detect events and fit parameters.

    Args:
        time: Time array
        signal: Signal array
        before_lim: Time before event to include
        after_lim: Time after event to include
        threshold_factor: Peak detection threshold multiplier
        min_distance: Minimum distance between peaks (frames)

    Returns:
        dict with detected events and fit results
    """
    try:
        t = np.array(time)
        x = np.array(signal)

        # Detect events
        event_times = detect_events(x, t, threshold_factor, min_distance)

        if len(event_times) == 0:
            return {"error": "No events detected in signal"}

        # Fit parameters
        fit_result = fit_parameters(time, signal, event_times, before_lim, after_lim)

        return {
            "event_times": event_times,
            "num_events": len(event_times),
            "fit_results": fit_result.get("results", []),
            "error": fit_result.get("error")
        }

    except Exception as e:
        return {"error": str(e)}


def save_parameters(results, file_path, session_id):
    """
    Save fitted parameters to CSV file.

    Args:
        results: List of fitting results
        file_path: Path to save CSV file
        session_id: Session identifier for reference
    """
    try:
        with open(file_path, 'a') as fout:
            fout.write(f'SessionID={session_id} # a,b,tau,d, fitb, fitd, fita (b*(1 - np.exp(-(t-d)/tau))*(t>=d) + a)\n')

            for result in results:
                if "error" not in result:
                    fout.write(f"{result['index']}, ")
                    fout.write(f"{result['a']:.6f}, {result['b']:.6f}, {result['tau']:.6f}, {result['d']:.6f}, ")
                    fout.write(f"{result['fit_before']:.6f}, {result['fit_during']:.6f}, {result['fit_after']:.6f}\n")

        return {"success": True, "path": file_path}

    except Exception as e:
        return {"error": str(e)}


def main():
    """Main entry point for CLI usage."""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command specified"}))
        sys.exit(1)

    command = sys.argv[1]

    try:
        if command == "read":
            # Read tracking file: python analyze_recording.py read <file_path> <signal_type>
            file_path = sys.argv[2]
            signal_type = sys.argv[3] if len(sys.argv) > 3 else "gaze_x"

            result = read_tracking_data(file_path, signal_type)
            print(json.dumps(result))

        elif command == "detect":
            # Auto-detect events: python analyze_recording.py detect <json_data>
            data = json.loads(sys.argv[2])

            result = auto_detect_and_fit(
                data["time"],
                data["signal"],
                data["before_lim"],
                data["after_lim"],
                data.get("threshold_factor", 2.0),
                data.get("min_distance", 30)
            )
            print(json.dumps(result))

        elif command == "fit":
            # Fit parameters: python analyze_recording.py fit <json_data>
            data = json.loads(sys.argv[2])

            result = fit_parameters(
                data["time"],
                data["signal"],
                data["event_times"],
                data["before_lim"],
                data["after_lim"]
            )
            print(json.dumps(result))

        elif command == "save":
            # Save parameters: python analyze_recording.py save <json_data>
            data = json.loads(sys.argv[2])

            result = save_parameters(
                data["results"],
                data["file_path"],
                data["session_id"]
            )
            print(json.dumps(result))

        else:
            print(json.dumps({"error": f"Unknown command: {command}"}))
            sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
