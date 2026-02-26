import cv2
import math

# Visualization colors
VIS_COLORS = {
    'left_dot': (0, 0, 255),
    'right_dot': (255, 0, 0),
    'mid': (0, 255, 255),  # final iris center / gaze
    'text': (255, 255, 255),
    'rough': (0, 255, 0),  # rough MP iris center
    'extreme_lr': (0, 165, 255),  # left/right extrema (orange)
    'extreme_tb': (255, 0, 255),  # top/bottom extrema (magenta)
    'roi_box': (0, 255, 0),  # ROI rectangle
    'head_ok': (0, 220, 0),
}


def _is_finite_number(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def _fmt_int(value):
    return str(int(value)) if _is_finite_number(value) else "--"


def _fmt_float(value, digits=2):
    return f"{value:.{digits}f}" if _is_finite_number(value) else "--"

def draw_overlay(frame, data, total_frames):
    """
    Draws text and graphics overlay on the video frame for visualization.
    """
    overlay = frame.copy()
    cv2.rectangle(overlay, (5, 5), (650, 190), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.7, frame, 0.3, 0, frame)

    y = 25
    cv2.putText(frame, f"Frame: {data['frame']}/{total_frames}",
                (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, VIS_COLORS['text'], 1)
    y += 25
    cv2.putText(frame, f"Time: {data['time_formatted']}",
                (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, VIS_COLORS['text'], 1)
    y += 25

    if 'left_center_x' in data:
        cv2.putText(frame,
                    f"L center: ({_fmt_int(data.get('left_center_x'))},{_fmt_int(data.get('left_center_y'))}) "
                    f"conf {_fmt_float(data.get('left_confidence'))} [{data.get('left_method', '--')}]",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['left_dot'], 1)
    y += 25
    if 'right_center_x' in data:
        cv2.putText(frame,
                    f"R center: ({_fmt_int(data.get('right_center_x'))},{_fmt_int(data.get('right_center_y'))}) "
                    f"conf {_fmt_float(data.get('right_confidence'))} [{data.get('right_method', '--')}]",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['right_dot'], 1)
    y += 25
    if 'gaze_x' in data:
        cv2.putText(frame, f"Gaze: ({_fmt_int(data.get('gaze_x'))},{_fmt_int(data.get('gaze_y'))})",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['mid'], 1)
    y += 25
    # Legend text (raw data always present, visual overlay conditional)
    legend_text = "Green=MP center  Yellow=Final center  Orange=LR edges  Magenta=TB edges  Red=RAW"
    cv2.putText(frame, legend_text,
                (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.4, VIS_COLORS['text'], 1)

    if data.get('head_status') == "READY":
        w = frame.shape[1]
        x = max(10, min(620, w - 20))
        cv2.circle(frame, (x, 20), 6, VIS_COLORS['head_ok'], -1)
        cv2.putText(frame, "Head OK", (x + 10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.4,
                    VIS_COLORS['head_ok'], 1)
