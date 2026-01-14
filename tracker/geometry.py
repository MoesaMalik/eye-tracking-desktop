import cv2
import numpy as np
try:
    from .image_proc import preprocess_eye
except (ImportError, ValueError):
    from image_proc import preprocess_eye

# ROI
EYE_PAD = 15  # fallback
DYN_ROI_SCALE = 3.0  # ROI side ≈ k * iris radius (pixels)

# Ring selection around iris (for edge points)
RING_INNER_FRAC = 0.70  # widened from 0.85
RING_OUTER_FRAC = 1.40  # widened from 1.15

# Canny params
CANNY_LO = 20  # lowered from 30
CANNY_HI = 90
ADAPT_BLOCK = 21
ADAPT_C = 2  # lowered from 3

def get_eye_roi(landmarks, eye_indices, w, h, padding=EYE_PAD):
    """
    Extracts a rectangular Region of Interest (ROI) around the eye based on landmarks.
    
    Args:
        landmarks: MediaPipe landmarks.
        eye_indices: Indices of landmarks belonging to the eye.
        w, h: Image width and height.
        padding: Padding in pixels to add around the eye landmarks.
    """
    pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in eye_indices], dtype=np.float32)
    x0, y0 = np.floor(pts.min(axis=0) - padding).astype(int)
    x1, y1 = np.ceil(pts.max(axis=0) + padding).astype(int)
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


def get_eye_roi_dynamic(w, h, iris_center, iris_radius, k=DYN_ROI_SCALE):
    """
    Extracts an ROI around the iris, scaled by the iris radius, to ensure we catch enough context
    but not too much noise.
    """
    cx, cy = iris_center
    s = int(round(k * max(12, iris_radius)))
    x0, y0 = int(cx - s), int(cy - s)
    x1, y1 = int(cx + s), int(cy + s)
    return max(0, x0), max(0, y0), min(w, x1), min(h, y1)


def iris_center_radius(landmarks, iris_indices, w, h):
    """
    Calculates the center and radius of the iris from MediaPipe landmarks.
    """
    pts = np.array([(landmarks[i].x * w, landmarks[i].y * h) for i in iris_indices], dtype=np.float32)
    cx, cy = pts.mean(axis=0)
    r = np.mean(np.linalg.norm(pts - np.array([cx, cy], dtype=np.float32), axis=1))
    return float(cx), float(cy), float(r)


def refine_center_with_extrema(pts, approx_center, min_span_px=4):
    """
    Refines the center of the iris by considering the extremum points (leftmost, rightmost, top, bottom).
    This helps when the iris is partially occluded.
    
    Args:
        pts (np.ndarray): Edge points.
        approx_center (tuple): Approximate center (x, y).
        min_span_px (int): Minimum span to consider valid extrema.
        
    Returns:
        tuple or None: (refined_cx, refined_cy, x_min, x_max, y_min, y_max)
    """
    if pts is None or len(pts) < 10:
        return None

    ys = pts[:, 0].astype(np.float32)
    xs = pts[:, 1].astype(np.float32)

    x_min = xs.min()
    x_max = xs.max()
    y_min = ys.min()
    y_max = ys.max()

    span_x = x_max - x_min
    span_y = y_max - y_min

    if span_x < min_span_px:
        return None

    cx_h = 0.5 * (x_min + x_max)

    if span_y >= min_span_px:
        cy_v = 0.5 * (y_min + y_max)
    else:
        cy_v = approx_center[1]

    return float(cx_h), float(cy_v), float(x_min), float(x_max), float(y_min), float(y_max)


def iris_center_ellipse(roi_bgr, approx_center_roi, approx_radius_roi):
    """
    Determines the iris center by fitting an ellipse to edges detected in the ROI.
    
    1. Preprocesses ROI (glint removal, CLAHE).
    2. Adaptive thresholding + Canny edge detection.
    3. Selects edge points within a ring defined by approx_radius_roi.
    4. Fits an ellipse to these points using cv2.fitEllipse.
    5. Refines the center using extrema analysis.
    
    Returns:
        tuple or None: (cx, cy, confidence, ellipse_params, circularity, num_points, ...extrema...)
    """
    h, w = roi_bgr.shape[:2]
    if min(h, w) < 12:
        return None

    gray = preprocess_eye(roi_bgr)
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, ADAPT_BLOCK, ADAPT_C)
    edges = cv2.Canny(gray, CANNY_LO, CANNY_HI)

    Y, X = np.indices((h, w))
    r = np.sqrt((X - approx_center_roi[0]) ** 2 + (Y - approx_center_roi[1]) ** 2)
    ring = (r > RING_INNER_FRAC * approx_radius_roi) & (r < RING_OUTER_FRAC * approx_radius_roi)

    pts = np.column_stack(np.where((edges > 0) & (dark > 0) & ring))
    if len(pts) < 20:
        return None

    if len(pts) > 1000:
        idx = np.random.choice(len(pts), 1000, replace=False)
        pts = pts[idx]

    pts_xy = pts[:, ::-1].astype(np.float32)
    try:
        ellipse = cv2.fitEllipse(pts_xy)
        (cx_init, cy_init), (MA, ma), angle = ellipse
        circ = min(MA, ma) / max(MA, ma + 1e-6)
        ok_size = 5 <= min(MA, ma) <= 150
        if not ok_size:
            return None

        t = np.linspace(0, 2 * np.pi, 64, endpoint=False)
        a, b = MA / 2.0, ma / 2.0
        cosA, sinA = np.cos(np.deg2rad(angle)), np.sin(np.deg2rad(angle))
        xs_samp = cx_init + a * np.cos(t) * cosA - b * np.sin(t) * sinA
        ys_samp = cy_init + a * np.cos(t) * sinA + b * np.sin(t) * cosA
        xs_samp = np.clip(xs_samp.astype(int), 0, w - 1)
        ys_samp = np.clip(ys_samp.astype(int), 0, h - 1)
        perim_hits = (edges[ys_samp, xs_samp] > 0).sum()
        inlier_frac = perim_hits / 64.0

        ext = refine_center_with_extrema(pts, approx_center_roi)
        if ext is not None:
            cx, cy, x_min, x_max, y_min, y_max = ext
        else:
            cx, cy = cx_init, cy_init
            x_min = x_max = y_min = y_max = None

        ellipse_refined = ((float(cx), float(cy)), (MA, ma), angle)

        # Favor inlier_frac heavily over circularity to allow for side glances (elliptical iris)
        conf = float(np.clip(0.7 * inlier_frac + 0.3 * circ, 0.0, 1.0))
        return (float(cx), float(cy), conf, ellipse_refined, float(circ), int(len(pts)),
                x_min, x_max, y_min, y_max)
    except:
        return None


def _taubin_circle_fit(x, y):
    """
    Algebraic circle fit (Taubin method).
    Generally more stable than standard least squares for circle fitting.
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if x.size < 3:
        return None
    x_m = x.mean()
    y_m = y.mean()
    u = x - x_m
    v = y - y_m

    Suu = np.sum(u * u)
    Suv = np.sum(u * v)
    Svv = np.sum(v * v)
    Suuu = np.sum(u * u * u)
    Svvv = np.sum(v * v * v)
    Suvv = np.sum(u * v * v)
    Svuu = np.sum(v * u * u)

    A = np.array([[Suu, Suv],
                  [Suv, Svv]], dtype=np.float64)
    b = 0.5 * np.array([Suuu + Suvv, Svvv + Svuu], dtype=np.float64)

    det = A[0, 0] * A[1, 1] - A[0, 1] * A[1, 0]
    if abs(det) < 1e-12:
        return None

    uc, vc = np.linalg.solve(A, b)
    xc = x_m + uc
    yc = y_m + vc
    r = np.sqrt(uc * uc + vc * vc + (Suu + Svv) / x.size)
    return float(xc), float(yc), float(r)


def iris_center_circle(roi_bgr, approx_center_roi, approx_radius_roi):
    """
    Determines the iris center by fitting a circle to edges detected in the ROI.
    Uses Taubin's method which is robust to noise.
    """
    h, w = roi_bgr.shape[:2]
    if min(h, w) < 12:
        return None
    gray = preprocess_eye(roi_bgr)
    dark = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                 cv2.THRESH_BINARY_INV, ADAPT_BLOCK, ADAPT_C)
    edges = cv2.Canny(gray, CANNY_LO, CANNY_HI)

    Y, X = np.indices((h, w))
    r = np.sqrt((X - approx_center_roi[0]) ** 2 + (Y - approx_center_roi[1]) ** 2)
    ring = (r > RING_INNER_FRAC * approx_radius_roi) & (r < RING_OUTER_FRAC * approx_radius_roi)

    pts = np.column_stack(np.where((edges > 0) & (dark > 0) & ring))
    if len(pts) < 8:
        return None

    if len(pts) > 1200:
        idx = np.random.choice(len(pts), 1200, replace=False)
        pts = pts[idx]

    xs = pts[:, 1].astype(np.float64)
    ys = pts[:, 0].astype(np.float64)
    fit = _taubin_circle_fit(xs, ys)
    if fit is None:
        return None
    cx_init, cy_init, rad = fit

    ext = refine_center_with_extrema(pts, approx_center_roi)
    if ext is not None:
        cx, cy, x_min, x_max, y_min, y_max = ext
    else:
        cx, cy = cx_init, cy_init
        x_min = x_max = y_min = y_max = None

    d = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    resid = np.abs(d - rad)
    thr = max(1.5, 0.08 * rad)
    inlier_frac = float((resid < thr).mean())
    conf = float(np.clip(inlier_frac, 0.0, 1.0))
    return (float(cx), float(cy), conf, float(rad), int(len(pts)),
            x_min, x_max, y_min, y_max)

def compute_midpoint(p1, p2):
    return ((p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5)

def calculate_ear(landmarks, eye_indices, w, h):
    """
    Calculates Eye Aspect Ratio (EAR) to detect blinks.
    EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
    
    Using standard 6-point EAR mapping for MediaPipe:
    Left Eye: 33 (p1), 160 (p2), 158 (p3), 133 (p4), 153 (p5), 144 (p6)
    Right Eye: 362 (p1), 385 (p2), 387 (p3), 263 (p4), 373 (p5), 380 (p6)
    """
    # Helper to get numpy point
    def p(idx):
        return np.array([landmarks[idx].x * w, landmarks[idx].y * h])

    # Unpack indices (assumes standard 6-point order)
    p1, p2, p3, p4, p5, p6 = [p(i) for i in eye_indices]

    v1 = np.linalg.norm(p2 - p6)
    v2 = np.linalg.norm(p3 - p5)
    hor = np.linalg.norm(p1 - p4)

    if hor == 0:
        return 0.0
    
    return (v1 + v2) / (2.0 * hor)

