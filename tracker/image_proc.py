import cv2
import numpy as np

# Processing params
CLAHE_CLIP_LIMIT = 3.0
CLAHE_GRID_SIZE = (8, 8)

# Glint suppression
GLINT_PERCENTILE = 99.0  # top 1% brightest pixels
GLINT_INPAINT_RADIUS = 2
USE_HSV_GLINT = True  # HSV-based specular mask before inpaint

def suppress_glints(gray):
    """
    Removes specular highlights (glints) using a simple brightness threshold and inpainting.
    Useful for removing corneal reflections that confuse edge detection.
    """
    p = np.percentile(gray, GLINT_PERCENTILE)
    _, mask = cv2.threshold(gray, int(p), 255, cv2.THRESH_BINARY)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros_like(mask)
    for i in range(1, num_labels):
        area = stats[i, cv2.CC_STAT_AREA]
        # Keep only small bright spots likely to be glints
        if 1 <= area <= 200:
            keep[labels == i] = 255
    if np.any(keep):
        return cv2.inpaint(gray, keep, GLINT_INPAINT_RADIUS, cv2.INPAINT_TELEA)
    return gray


def suppress_glints_hsv(bgr):
    """
    More robust glint suppression working in HSV color space.
    Target pixels with high Value (brightness) and low Saturation (white/gray).
    """
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    H, S, V = cv2.split(hsv)
    vthr = np.percentile(V, 98)
    # White/bright spots mask
    mask = ((V > vthr) & (S < 60)).astype(np.uint8) * 255
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if mask.any():
        return cv2.inpaint(gray, mask, GLINT_INPAINT_RADIUS, cv2.INPAINT_TELEA)
    return gray


def preprocess_eye(roi_bgr):
    """
    Preprocesses the eye image: removes glints and improves contrast using CLAHE.
    """
    if USE_HSV_GLINT:
        gray = suppress_glints_hsv(roi_bgr)
    else:
        gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)
        gray = suppress_glints(gray)
    
    # Gamma correction to boost visibility in dark eyes/environments
    # Gamma > 1.0 brightens shadows.
    invGamma = 1.0 / 1.2  # conservative boost
    table = np.array([((i / 255.0) ** invGamma) * 255 for i in np.arange(0, 256)]).astype("uint8")
    gray = cv2.LUT(gray, table)

    # CLAHE (Contrast Limited Adaptive Histogram Equalization) to enhance local contrast
    clahe = cv2.createCLAHE(clipLimit=CLAHE_CLIP_LIMIT, tileGridSize=CLAHE_GRID_SIZE)
    gray = clahe.apply(gray)
    return gray
