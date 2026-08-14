/** Validates and creates executable draw functions from AI-generated code */

/**
 * Patterns that are not allowed in draw function code.
 *
 * DEFENSE-IN-DEPTH, NOT A SECURITY BOUNDARY. This denylist is a best-effort
 * filter against obvious abuse; a determined attacker can always obfuscate
 * around a regex denylist (string concatenation, char codes, etc.). Untrusted
 * agent-generated bodies MUST ALSO be process-isolated (run outside the main
 * Next.js server process — e.g. the headless-Chromium render path or a
 * locked-down worker) so that a bypass here cannot become RCE. Adding a pattern
 * raises the bar; it never replaces the isolation requirement.
 */
const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bfetch\s*\(/, label: 'fetch() calls' },
  { pattern: /\beval\s*\(/, label: 'eval() calls' },
  { pattern: /\bFunction\s*\(/, label: 'Function() constructor' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import()' },
  { pattern: /\bimport\s+/, label: 'import statements' },
  { pattern: /\brequire\s*\(/, label: 'require() calls' },
  { pattern: /\bdocument\.cookie\b/, label: 'document.cookie access' },
  { pattern: /\blocalStorage\b/, label: 'localStorage access' },
  { pattern: /\bsessionStorage\b/, label: 'sessionStorage access' },
  { pattern: /\bwindow\.open\s*\(/, label: 'window.open() calls' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest usage' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket usage' },
  { pattern: /\bpostMessage\s*\(/, label: 'postMessage() calls' },
  { pattern: /\b__proto__\b/, label: '__proto__ access' },
  { pattern: /\bconstructor\s*\[/, label: 'constructor bracket access' },
  // Navigation via window.location / location.href / location.assign(...).
  { pattern: /\blocation\b/, label: 'location access' },
  // Dot-form constructor walk (`.constructor.constructor`) that the bracket
  // pattern above misses — the classic Function-constructor escape.
  { pattern: /\.\s*constructor\b/, label: 'constructor property access' },
  // Computed/bracket access to dangerous identifiers via a string literal,
  // e.g. window['fetch'], self['process'], obj["constructor"].
  {
    pattern: /\[\s*['"\x60]\s*(fetch|process|constructor|require|eval|import|Function|globalThis|window|self)\b/,
    label: 'computed dangerous property access',
  },
  // Node global: the server-side render path is the RCE surface.
  { pattern: /\bprocess\b/, label: 'process access' },
  { pattern: /\bglobalThis\b/, label: 'globalThis access' },
];

/**
 * Result of validating a draw function.
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates that a draw function code string is syntactically valid and does
 * not contain dangerous patterns.
 *
 * @param code - The function body string to validate
 * @returns An object indicating whether the code is valid, with an error message if not
 */
export function validateDrawFunction(code: string): ValidationResult {
  // Check for empty code
  if (!code || code.trim().length === 0) {
    return { valid: false, error: 'Draw function code is empty' };
  }

  // Check for dangerous patterns
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return {
        valid: false,
        error: `Draw function contains disallowed pattern: ${label}`,
      };
    }
  }

  // Check syntactic validity by attempting to parse as a function body
  try {
    // eslint-disable-next-line no-new-func
    new Function('context', code);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      error: `Draw function has a syntax error: ${message}`,
    };
  }

  return { valid: true };
}

/** Named params injected into a three-overlay scene body. Kept in sync with
 *  buildThreeInstance() in lib/engine/three-overlay.ts. */
export const THREE_PARAM_NAMES = [
  "THREE",
  "scene",
  "camera",
  "renderer",
  "width",
  "height",
  "Text",
  "helpers",
  "three3d",
] as const;

/**
 * Validates a three-overlay scene body. Same blocklist as draw functions
 * (three.js + the Text class are INJECTED, never imported by the body) plus a
 * syntax check against the injected-param signature.
 */
export function validateThreeFunction(code: string): ValidationResult {
  if (!code || code.trim().length === 0) {
    return { valid: false, error: "Three scene function code is empty" };
  }
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return { valid: false, error: `Three scene function contains disallowed pattern: ${label}` };
    }
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(...(THREE_PARAM_NAMES as unknown as string[]), code);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Three scene function has a syntax error: ${message}` };
  }
  return { valid: true };
}

/**
 * SOFT, non-fatal resource-budget heuristic for three-overlay bodies. Returns a
 * human-readable warning when the body looks like it will create a very large
 * amount of geometry (the main perf/DoS risk), else null. NEVER rejects — the
 * hard gate is validateThreeFunction; this is advisory only. Deliberately
 * conservative to avoid false positives; the three-overlays skill carries the
 * real perf guidance.
 */
export function warnThreeFunction(code: string): string | null {
  const warnings: string[] = [];

  // High geometry segment counts: new THREE.<X>Geometry(<args with a number > 512>)
  const geoRe = /new\s+THREE\.\w*Geometry\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = geoRe.exec(code)) !== null) {
    const nums = (m[1].match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (nums.some((n) => n > 512)) {
      warnings.push(
        "high geometry segment count (>512) — this can create a very heavy mesh; prefer modest segment counts for an overlay",
      );
      break;
    }
  }

  // Large mesh-building loop: a loop bound > 10000 alongside object creation.
  const buildsObjects = /new\s+THREE\.|new\s+Text\s*\(/.test(code);
  const loopBoundRe = /[<>]=?\s*(\d{5,})/g;
  let big = false;
  while ((m = loopBoundRe.exec(code)) !== null) {
    if (Number(m[1]) > 10000) { big = true; break; }
  }
  if (big && buildsObjects) {
    warnings.push(
      "a loop appears to build >10000 objects — building many meshes/Text in a loop will tax the 30 Hz preview; keep 3D overlays lightweight",
    );
  }

  return warnings.length ? warnings.join("; ") : null;
}

/**
 * Creates an executable draw function from a code string, injecting the
 * animation and drawing helpers into the function's scope.
 *
 * The returned function has the signature:
 *   (context: DrawContext) => void | Promise<void>
 *
 * @param code - The function body string
 * @param helpers - An object whose keys are helper names and values are the helper functions/values
 * @returns A callable function that accepts a DrawContext
 */
export function createDrawFunction(
  code: string,
  helpers: Record<string, unknown>,
): (context: Record<string, unknown>) => unknown {
  // Enforced at LOAD, not only on the MCP write paths. A composition.json can
  // arrive by routes that never touch a tool call — a shared piece, a restored
  // backup, a duplicate — and this body executes at the app's own origin, where
  // CSP `connect-src 'self'` means the local API is reachable. The denylist is
  // NOT a security boundary (see the header comment above) and does not make an
  // untrusted piece safe; this closes the gap where no check ran at all.
  const verdict = validateDrawFunction(code);
  if (!verdict.valid) {
    throw new Error(verdict.error ?? "Invalid draw function");
  }

  const helperNames = Object.keys(helpers);
  const helperValues = Object.values(helpers);

  // Build a function that receives the helpers as named parameters, plus context
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...helperNames,
    'context',
    code,
  );

  // Return a wrapper that pre-fills the helpers
  return (context: Record<string, unknown>) => {
    return factory(...helperValues, context);
  };
}

/**
 * Creates an executable animate function from a custom effect's `animate.js`
 * body, injecting the pure-math helpers into scope. The body is validated
 * through the SAME sandbox as draw functions (`validateDrawFunction` — rejects
 * require/import/network/etc.) and THROWS a descriptive error on validation
 * failure (the caller maps that to a `{ ok: false }` result).
 *
 * The returned function has the signature:
 *   (progress: number, params: Record<string, unknown>) => TransformDelta
 *
 * Runtime safety: a body that throws → returns `{}` (identity delta); a body
 * that returns a non-object (null/number/etc.) → coerced to `{}`. So the
 * returned function NEVER throws and ALWAYS yields a plain object.
 *
 * @param source - The animate function body string
 * @param helpers - Pure-math helpers injected as named params (no canvas/ctx)
 * @returns A callable `(progress, params) => TransformDelta`
 */
export function createAnimateFunction(
  source: string,
  helpers: Record<string, unknown>,
): (progress: number, params: Record<string, unknown>) => Record<string, unknown> {
  const result = validateDrawFunction(source);
  if (!result.valid) {
    throw new Error(result.error ?? "Invalid animate function");
  }

  const helperNames = Object.keys(helpers);
  const helperValues = Object.values(helpers);

  // Build a function that receives the helpers as named parameters, plus the
  // animate signature (progress, params).
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...helperNames,
    "progress",
    "params",
    source,
  );

  return (progress: number, params: Record<string, unknown>) => {
    let out: unknown;
    try {
      out = factory(...helperValues, progress, params);
    } catch {
      return {};
    }
    if (out === null || typeof out !== "object") return {};
    return out as Record<string, unknown>;
  };
}
