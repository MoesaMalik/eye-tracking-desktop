// src/lib/calibration-utils.ts

export type AffineModel = {
    coeffs: {
        sx: [number, number, number];
        sy: [number, number, number];
    };
};

/**
 * Predict screen coordinates from gaze coordinates using affine model
 */
export function predictScreen(
    model: AffineModel,
    gx: number,
    gy: number
): { x: number; y: number } {
    const [a1, a2, a3] = model.coeffs.sx;
    const [b1, b2, b3] = model.coeffs.sy;
    return {
        x: a1 * gx + a2 * gy + a3,
        y: b1 * gx + b2 * gy + b3,
    };
}

export type CalibrationTarget = {
    filename: string;
    raw_x: number;
    raw_y: number;
};

/**
 * Find nearest target to predicted point using Euclidean distance
 */
export function nearestTarget(
    pred: { x: number; y: number },
    targets: CalibrationTarget[]
): { best: CalibrationTarget; dist: number } {
    if (targets.length === 0) {
        throw new Error("No targets provided for classification");
    }

    let best = targets[0];
    let bestD = Infinity;

    for (const t of targets) {
        const dx = pred.x - t.raw_x;
        const dy = pred.y - t.raw_y;
        const d = Math.hypot(dx, dy);
        if (d < bestD) {
            bestD = d;
            best = t;
        }
    }

    return { best, dist: bestD };
}

export type GazeSample = {
    t_ms: number;
    gx: number;
    gy: number;
};

/**
 * Rolling buffer for gaze samples with 500ms window averaging
 */
export class GazeBuffer {
    private samples: GazeSample[] = [];
    private readonly windowMs = 500;

    /**
     * Add a new gaze sample
     */
    add(gx: number, gy: number, t_ms: number = Date.now()) {
        this.samples.push({ t_ms, gx, gy });
        // Clean old samples (keep last 1 second for safety)
        const cutoff = t_ms - 1000;
        this.samples = this.samples.filter((s) => s.t_ms > cutoff);
    }

    /**
     * Get average gaze over last 500ms
     * Returns null if insufficient samples
     * @deprecated Use getAverageAt for precise timing
     */
    getAverage(minSamples = 5): { gx: number; gy: number; n: number } | null {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        const windowSamples = this.samples.filter(
            (s) => s.t_ms >= windowStart && s.t_ms <= now
        );

        if (windowSamples.length < minSamples) {
            return null;
        }

        const sumGx = windowSamples.reduce((sum, s) => sum + s.gx, 0);
        const sumGy = windowSamples.reduce((sum, s) => sum + s.gy, 0);
        const n = windowSamples.length;

        return {
            gx: sumGx / n,
            gy: sumGy / n,
            n,
        };
    }

    /**
     * Get average gaze at a specific end time with window
     * Returns null if insufficient samples
     */
    getAverageAt(
        tEndMs: number,
        windowMs = 500,
        minSamples = 5
    ): { gx: number; gy: number; n: number } | null {
        const windowStart = tEndMs - windowMs;

        const windowSamples = this.samples.filter(
            (s) => s.t_ms >= windowStart && s.t_ms <= tEndMs
        );

        if (windowSamples.length < minSamples) {
            return null;
        }

        const sumGx = windowSamples.reduce((sum, s) => sum + s.gx, 0);
        const sumGy = windowSamples.reduce((sum, s) => sum + s.gy, 0);
        const n = windowSamples.length;

        return {
            gx: sumGx / n,
            gy: sumGy / n,
            n,
        };
    }

    /**
     * Clear all samples
     */
    clear() {
        this.samples = [];
    }

    /**
     * Get current sample count
     */
    getCount(): number {
        return this.samples.length;
    }
}
