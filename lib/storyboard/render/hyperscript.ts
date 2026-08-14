export type RenderFrame = { width: number; height: number };

type El = { type: string; props: Record<string, unknown> };

/** Minimal hyperscript for Satori — avoids a JSX transpile step. Produces the
 *  element shape Satori consumes: `{ type, props: { …, children } }`. */
export function h(
  type: string,
  props?: Record<string, unknown> | null,
  ...children: unknown[]
): El {
  const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
  return { type, props: { ...(props ?? {}), ...(kids !== undefined ? { children: kids } : {}) } };
}
