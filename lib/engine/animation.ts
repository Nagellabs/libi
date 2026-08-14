/** Animation utilities for the Libi composition engine */

/** A function that maps a progress value (0-1) to an eased value */
export type EasingFunction = (t: number) => number;

/** Options for the interpolate function */
export interface InterpolateOptions {
  /** Whether to clamp the output to the output range. Default: true */
  clamp?: boolean;
  /** Easing function to apply. Default: linear */
  easing?: EasingFunction;
}

/** Configuration for spring physics animation */
export interface SpringConfig {
  /** Spring stiffness coefficient. Default: 100 */
  stiffness?: number;
  /** Damping coefficient. Default: 10 */
  damping?: number;
  /** Mass of the object. Default: 1 */
  mass?: number;
}

// ---------------------------------------------------------------------------
// Easing functions
// ---------------------------------------------------------------------------

export const linear: EasingFunction = (t) => t;

export const easeIn: EasingFunction = (t) => t * t;

export const easeOut: EasingFunction = (t) => t * (2 - t);

export const easeInOut: EasingFunction = (t) =>
  t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

export const easeInCubic: EasingFunction = (t) => t * t * t;

export const easeOutCubic: EasingFunction = (t) => {
  const t1 = t - 1;
  return t1 * t1 * t1 + 1;
};

export const easeInOutCubic: EasingFunction = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeInBack: EasingFunction = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return c3 * t * t * t - c1 * t * t;
};

export const easeOutBack: EasingFunction = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const t1 = t - 1;
  return 1 + c3 * t1 * t1 * t1 + c1 * t1 * t1;
};

export const easeOutElastic: EasingFunction = (t) => {
  if (t === 0 || t === 1) return t;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

/** Standard 4-stage bounce. f(0) = 0, f(1) = 1. */
export const easeOutBounce: EasingFunction = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) {
    return n1 * t * t;
  } else if (t < 2 / d1) {
    const t1 = t - 1.5 / d1;
    return n1 * t1 * t1 + 0.75;
  } else if (t < 2.5 / d1) {
    const t1 = t - 2.25 / d1;
    return n1 * t1 * t1 + 0.9375;
  } else {
    const t1 = t - 2.625 / d1;
    return n1 * t1 * t1 + 0.984375;
  }
};

/**
 * Per-item reveal progress for staggered (one-after-another) animations.
 *
 * Splits a global 0→1 `progress` into `count` overlapping slices and returns
 * the local 0→1 progress of item `index`. `overlap` (0→1) controls how much an
 * item's slice overlaps its neighbour: 0 = strictly sequential, →1 = nearly
 * simultaneous. Used by typewriter / fade-in-words / slide-up-lines templates.
 */
export function stagger(
  progress: number,
  index: number,
  count: number,
  overlap = 0,
): number {
  if (count <= 0) return 0;
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const o = overlap < 0 ? 0 : overlap > 0.95 ? 0.95 : overlap;
  // Each item owns a slice of width `slice`; consecutive starts are `step` apart.
  const slice = 1 / (count - (count - 1) * o || 1);
  const step = slice * (1 - o);
  const start = index * step;
  const local = (p - start) / slice;
  return local < 0 ? 0 : local > 1 ? 1 : local;
}

// ---------------------------------------------------------------------------
// interpolate
// ---------------------------------------------------------------------------

/**
 * Maps a frame number to an output value by linearly interpolating between
 * corresponding input/output range pairs.
 *
 * @param frame - The current frame number
 * @param inputRange - Ascending array of frame breakpoints (at least 2 values)
 * @param outputRange - Corresponding output values (same length as inputRange)
 * @param options - Optional clamp and easing settings
 * @returns The interpolated value
 */
export function interpolate(
  frame: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: InterpolateOptions,
): number {
  if (inputRange.length < 2 || inputRange.length !== outputRange.length) {
    throw new Error(
      'inputRange and outputRange must have the same length (>= 2)',
    );
  }

  const clamp = options?.clamp ?? true;
  const easing = options?.easing ?? linear;

  // Find the segment the frame falls into
  let segmentIndex = 0;
  for (let i = 1; i < inputRange.length; i++) {
    if (frame >= inputRange[i]) {
      segmentIndex = i;
    } else {
      break;
    }
  }

  // Ensure segmentIndex points to the start of a valid segment
  segmentIndex = Math.min(segmentIndex, inputRange.length - 2);

  const inputStart = inputRange[segmentIndex];
  const inputEnd = inputRange[segmentIndex + 1];
  const outputStart = outputRange[segmentIndex];
  const outputEnd = outputRange[segmentIndex + 1];

  // Calculate raw progress within the segment
  let progress: number;
  if (inputEnd === inputStart) {
    progress = 0;
  } else {
    progress = (frame - inputStart) / (inputEnd - inputStart);
  }

  // Clamp progress to [0, 1] if clamping is enabled
  if (clamp) {
    progress = Math.max(0, Math.min(1, progress));
  }

  // Apply easing
  const easedProgress = easing(progress);

  // Linearly interpolate between output values
  return outputStart + (outputEnd - outputStart) * easedProgress;
}

// ---------------------------------------------------------------------------
// spring
// ---------------------------------------------------------------------------

/**
 * Spring physics animation (damped harmonic oscillator). Returns a value
 * that animates from 0 to 1 with spring-like motion.
 *
 * Uses the analytical solution for a damped harmonic oscillator:
 *   x(t) = 1 - e^(-zeta * omega_n * t) * (cos(omega_d * t) + (zeta * omega_n / omega_d) * sin(omega_d * t))
 *
 * @param frame - The current frame (treated as time in 1/60s increments)
 * @param config - Spring physics parameters
 * @returns A value animating from 0 toward 1
 */
export function spring(frame: number, config?: SpringConfig): number {
  const stiffness = config?.stiffness ?? 100;
  const damping = config?.damping ?? 10;
  const mass = config?.mass ?? 1;

  if (frame <= 0) return 0;

  // Convert frame to time (assuming 60fps for spring calculations)
  const t = frame / 60;

  // Natural frequency: omega_n = sqrt(k / m)
  const omega_n = Math.sqrt(stiffness / mass);

  // Damping ratio: zeta = c / (2 * sqrt(k * m))
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    // Under-damped: oscillates
    const omega_d = omega_n * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega_n * t);
    return (
      1 -
      decay *
        (Math.cos(omega_d * t) +
          ((zeta * omega_n) / omega_d) * Math.sin(omega_d * t))
    );
  } else if (zeta === 1) {
    // Critically damped: fastest return without oscillation
    const decay = Math.exp(-omega_n * t);
    return 1 - decay * (1 + omega_n * t);
  } else {
    // Over-damped: slow return without oscillation
    const s1 = -omega_n * (zeta + Math.sqrt(zeta * zeta - 1));
    const s2 = -omega_n * (zeta - Math.sqrt(zeta * zeta - 1));
    // Initial conditions: x(0) = 0, x'(0) = 0 => solving for coefficients
    // x(t) = 1 + A * e^(s1*t) + B * e^(s2*t)
    // A = s2 / (s1 - s2), B = -s1 / (s1 - s2)
    const A = s2 / (s1 - s2);
    const B = -s1 / (s1 - s2);
    return 1 + A * Math.exp(s1 * t) + B * Math.exp(s2 * t);
  }
}
