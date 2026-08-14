/** Context passed to all tool implementations */
export interface ToolContext {
  pieceId: string;
  /** Set when the tool was invoked from an ACP session; "" or undefined for HTTP/CLI callers. */
  sessionId?: string;
}

/**
 * Loose tool-result shape used by the ~20 non-tracking tools. Kept
 * permissive on purpose: a strict discriminated union here surfaces ~80
 * pre-existing un-narrowed `.error`/`.data` accesses across tools+tests
 * (measured) — that hardening is its own dedicated refactor, not this one.
 *
 * The canonical, type-safe generic result is `ToolResultOf<T, D>` below;
 * tracking tools use it. `ToolResultLoose` is assignable into the helper
 * sink type, so both coexist without the prior dual-declaration collision.
 */
export interface ToolResult {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * Type-safe, discriminated tool result. Single canonical generic
 * declaration — `tracking-tools.ts` re-exports this (previously it
 * declared a parallel copy, which collided with `ToolResult` through the
 * barrel). New tools should prefer this over the loose `ToolResult`.
 */
export type ToolResultOf<T = unknown, D = unknown> =
  | { success: true; data?: T }
  | { success: false; error: string; data?: D };

/**
 * Structural supertype both `ToolResult` and `ToolResultOf<…>` satisfy.
 * Use as the parameter type for sinks that only serialize the result
 * (e.g. `makeContent`) so they accept either shape with zero ripple.
 */
export type AnyToolResult = {
  success: boolean;
  error?: string;
  data?: unknown;
};
