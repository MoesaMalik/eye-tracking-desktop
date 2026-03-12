"""
Eye-tracking Excel data analysis script.
Reads Excel files, performs exponential curve fitting on eye-tracking signals.
Ported from fit-eye-parameters5.py for use in Electron app.
"""

import sys
import json
import numpy as np
import pandas as pd
from scipy.optimize import curve_fit
from pathlib import Path


# Event markers for different modes (in frames at 60.67 Hz)
EVENT_MARKERS = {
    0: np.array([82, 206, 326, 440, 558, 685, 805, 925, 1050, 1148,
                 1268, 1388, 1536, 1653, 1780, 1894, 2023, 2138,
                 2266, 2387, 2507, 2630]),  # Calibration mode
    1: np.array([]),  # Saccades mode (to be configured)
}


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
    return float(np.mean(np.abs(signal_segment)))


def read_excel_signal(file_path, sheet_number, time_column):
    """
    Read time and signal data from Excel file.

    Args:
        file_path: Path to Excel file
        sheet_number: Sheet index (0-based)
        time_column: Time column index (1-based, will be converted to 0-based)

    Returns:
        tuple: (time_array, signal_array, max_time)
    """
    try:
        xls = pd.ExcelFile(file_path)
        sheet_names = xls.sheet_names

        if sheet_number >= len(sheet_names):
            return {"error": f"Sheet {sheet_number} not found. File has {len(sheet_names)} sheets."}

        df = pd.read_excel(file_path, sheet_name=sheet_names[sheet_number], header=None)

        # Convert to 0-based index
        tcol = int(time_column) - 1

        # Read time and signal columns (skip first 8 rows, then pair of columns)
        t = df.iloc[:, tcol].values[8:].astype(np.double)
        x = df.iloc[:, tcol + 1].values[8:].astype(np.double)

        # Remove NaN values
        valid = ~np.isnan(t)
        t = t[valid] - 10  # Start offset
        x = x[valid]
        x = x - np.mean(x)  # Subtract average to center signal

        max_time = float(np.ceil(np.max(t)))

        return {
            "time": t.tolist(),
            "signal": x.tolist(),
            "max_time": max_time,
            "sheet_names": sheet_names
        }

    except Exception as e:
        return {"error": str(e)}


def fit_parameters(time, signal, mode, frame_rate, before_lim, after_lim):
    """
    Fit exponential curves to eye-tracking events.

    Args:
        time: Time array
        signal: Signal array
        mode: 0=calibration, 1=saccades
        frame_rate: Frame rate in Hz
        before_lim: Time before event to include (seconds)
        after_lim: Time after event to include (seconds)

    Returns:
        dict: Fitted parameters for each event
    """
    try:
        t = np.array(time)
        x = np.array(signal)

        # Get event markers for this mode
        if mode not in EVENT_MARKERS or len(EVENT_MARKERS[mode]) == 0:
            return {"error": f"No event markers defined for mode {mode}"}

        event_frames = EVENT_MARKERS[mode]
        event_times = event_frames / frame_rate

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


def save_parameters(results, file_path, filename):
    """
    Save fitted parameters to CSV file.

    Args:
        results: List of fitting results
        file_path: Path to save CSV file
        filename: Original Excel filename for reference
    """
    try:
        with open(file_path, 'a') as fout:
            fout.write(f'Fname={filename} # a,b,tau,d, fitb, fitd, fita (b*(1 - np.exp(-(t-d)/tau))*(t>=d) + a)\n')

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
            # Read Excel file: python analyze_excel.py read <file_path> <sheet_number> <time_column>
            file_path = sys.argv[2]
            sheet_number = int(sys.argv[3])
            time_column = int(sys.argv[4])

            result = read_excel_signal(file_path, sheet_number, time_column)
            print(json.dumps(result))

        elif command == "fit":
            # Fit parameters: python analyze_excel.py fit <json_data>
            data = json.loads(sys.argv[2])

            result = fit_parameters(
                data["time"],
                data["signal"],
                data["mode"],
                data["frame_rate"],
                data["before_lim"],
                data["after_lim"]
            )
            print(json.dumps(result))

        elif command == "save":
            # Save parameters: python analyze_excel.py save <json_data>
            data = json.loads(sys.argv[2])

            result = save_parameters(
                data["results"],
                data["file_path"],
                data["filename"]
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
