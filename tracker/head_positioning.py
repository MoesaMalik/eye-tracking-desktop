from collections import deque
from typing import Dict, List, Optional, Tuple

LANDMARK_LEFT_EYE = 33
LANDMARK_RIGHT_EYE = 263
LANDMARK_NOSE_TIP = 1
LANDMARK_MOUTH = 13

DEFAULT_TARGET_X = (0.35, 0.65)
DEFAULT_TARGET_Y = (0.30, 0.70)
DEFAULT_SIZE_RANGE = (0.18, 0.32)

DEFAULT_STABILITY_WINDOW = 20
DEFAULT_CENTER_DELTA = 0.01
DEFAULT_SIZE_DELTA = 0.01


def _mean(points: List[Tuple[float, float]]) -> Tuple[float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def compute_head_metrics(landmarks) -> Tuple[Tuple[float, float], float]:
    points = [
        (landmarks[LANDMARK_LEFT_EYE].x, landmarks[LANDMARK_LEFT_EYE].y),
        (landmarks[LANDMARK_RIGHT_EYE].x, landmarks[LANDMARK_RIGHT_EYE].y),
        (landmarks[LANDMARK_NOSE_TIP].x, landmarks[LANDMARK_NOSE_TIP].y),
        (landmarks[LANDMARK_MOUTH].x, landmarks[LANDMARK_MOUTH].y),
    ]
    center = _mean(points)

    lx, ly = landmarks[LANDMARK_LEFT_EYE].x, landmarks[LANDMARK_LEFT_EYE].y
    rx, ry = landmarks[LANDMARK_RIGHT_EYE].x, landmarks[LANDMARK_RIGHT_EYE].y
    dx = rx - lx
    dy = ry - ly
    size_norm = (dx * dx + dy * dy) ** 0.5
    return center, float(size_norm)


def _alignment_instruction(
    center: Tuple[float, float],
    size_norm: float,
    target_x: Tuple[float, float],
    target_y: Tuple[float, float],
    size_range: Tuple[float, float],
) -> Tuple[bool, Optional[str]]:
    aligned = True
    instructions: List[str] = []

    if center[0] < target_x[0]:
        aligned = False
        instructions.append("Move right")
    elif center[0] > target_x[1]:
        aligned = False
        instructions.append("Move left")

    if center[1] < target_y[0]:
        aligned = False
        instructions.append("Move down")
    elif center[1] > target_y[1]:
        aligned = False
        instructions.append("Move up")

    if size_norm < size_range[0]:
        aligned = False
        instructions.append("Move closer")
    elif size_norm > size_range[1]:
        aligned = False
        instructions.append("Move back")

    if aligned:
        return True, None
    return False, " and ".join(instructions)


class HeadPositioner:
    def __init__(
        self,
        target_x: Tuple[float, float] = DEFAULT_TARGET_X,
        target_y: Tuple[float, float] = DEFAULT_TARGET_Y,
        size_range: Tuple[float, float] = DEFAULT_SIZE_RANGE,
        window: int = DEFAULT_STABILITY_WINDOW,
        center_delta: float = DEFAULT_CENTER_DELTA,
        size_delta: float = DEFAULT_SIZE_DELTA,
    ):
        self.target_x = target_x
        self.target_y = target_y
        self.size_range = size_range
        self.window = window
        self.center_delta = center_delta
        self.size_delta = size_delta
        self.history: deque = deque(maxlen=window)
        self.stable_count = 0

    def reset(self) -> None:
        self.history.clear()
        self.stable_count = 0

    def assess(self, landmarks) -> Dict[str, object]:
        if landmarks is None:
            self.reset()
            return {
                "status": "NOT_DETECTED",
                "instruction": "Face not detected",
                "progress": 0.0,
                "metrics": {
                    "center": None,
                    "size": None,
                    "yaw": None,
                    "pitch": None,
                },
            }

        center, size_norm = compute_head_metrics(landmarks)
        aligned, instruction = _alignment_instruction(
            center, size_norm, self.target_x, self.target_y, self.size_range
        )

        if not aligned:
            self.reset()
            return {
                "status": "ALIGNING",
                "instruction": instruction or "Adjust position",
                "progress": 0.0,
                "metrics": {
                    "center": [center[0], center[1]],
                    "size": size_norm,
                    "yaw": None,
                    "pitch": None,
                },
            }

        self.history.append((center[0], center[1], size_norm))
        xs = [p[0] for p in self.history]
        ys = [p[1] for p in self.history]
        sizes = [p[2] for p in self.history]

        max_dx = max(xs) - min(xs) if len(xs) > 1 else 0.0
        max_dy = max(ys) - min(ys) if len(ys) > 1 else 0.0
        max_ds = max(sizes) - min(sizes) if len(sizes) > 1 else 0.0

        stable = (
            max_dx < self.center_delta
            and max_dy < self.center_delta
            and max_ds < self.size_delta
        )
        if stable:
            self.stable_count = min(self.window, self.stable_count + 1)
        else:
            self.stable_count = 0

        progress = min(1.0, self.stable_count / float(self.window))
        if self.stable_count >= self.window:
            status = "READY"
            instruction = "Good position"
        else:
            status = "STABILIZING"
            instruction = f"Hold still... {self.stable_count}/{self.window}"

        return {
            "status": status,
            "instruction": instruction,
            "progress": progress,
            "metrics": {
                "center": [center[0], center[1]],
                "size": size_norm,
                "yaw": None,
                "pitch": None,
            },
        }
