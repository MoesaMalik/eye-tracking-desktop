import cv2

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
}

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
                    f"L center: ({int(data['left_center_x'])},{int(data['left_center_y'])}) "
                    f"conf {data['left_confidence']:.2f} [{data['left_method']}]",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['left_dot'], 1)
    y += 25
    if 'right_center_x' in data:
        cv2.putText(frame,
                    f"R center: ({int(data['right_center_x'])},{int(data['right_center_y'])}) "
                    f"conf {data['right_confidence']:.2f} [{data['right_method']}]",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['right_dot'], 1)
    y += 25
    if 'gaze_x' in data:
        cv2.putText(frame, f"Gaze: ({int(data['gaze_x'])},{int(data['gaze_y'])})",
                    (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, VIS_COLORS['mid'], 1)
    y += 25
    # just a hint about colors
    cv2.putText(frame, "Green=MP center  Yellow=Final center  Orange=LR edges  Magenta=TB edges",
                (15, y), cv2.FONT_HERSHEY_SIMPLEX, 0.4, VIS_COLORS['text'], 1)
