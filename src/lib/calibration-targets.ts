// src/lib/calibration-targets.ts

import type { CalibrationTarget } from "./calibration-utils";

/**
 * Get the calibration target grid (4x3 = 12 targets)
 * Matches the calibration protocol slide filenames
 */
export function getCalibrationTargets(): CalibrationTarget[] {
    const cols = [192, 704, 1216, 1728];
    const rows = [108, 540, 972];

    const targets: CalibrationTarget[] = [];

    for (const y of rows) {
        for (const x of cols) {
            targets.push({
                filename: `${x}-${y}.png`,
                raw_x: x,
                raw_y: y,
            });
        }
    }

    return targets;
}

/**
 * Generate a random sequence of targets for validation
 * Uses random sampling without replacement until all targets used, then resamples
 */
export function generateValidationSequence(
    numTrials: number,
    targets: CalibrationTarget[]
): CalibrationTarget[] {
    const sequence: CalibrationTarget[] = [];
    const pool = [...targets];

    for (let i = 0; i < numTrials; i++) {
        if (pool.length === 0) {
            // Refill pool if exhausted
            pool.push(...targets);
        }

        const idx = Math.floor(Math.random() * pool.length);
        sequence.push(pool[idx]);
        pool.splice(idx, 1); // Remove to prevent immediate repeats
    }

    return sequence;
}
