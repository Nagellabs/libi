export interface LastGood<T> {
  value: T | null;
  error: string | null;
}

/** Compile `src`; on throw, retain `prev.value` (last good) and record the error. */
export function compileWithFallback<T>(
  src: string,
  compile: (src: string) => T,
  prev: LastGood<T>,
): LastGood<T> {
  try {
    return { value: compile(src), error: null };
  } catch (err) {
    return { value: prev.value, error: err instanceof Error ? err.message : String(err) };
  }
}
