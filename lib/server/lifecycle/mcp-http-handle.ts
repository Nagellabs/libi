/**
 * Where this process keeps its MCP endpoint supervisor, and the port every URL
 * it hands out must name.
 *
 * A leaf on purpose: `lib/mcp-config.ts`, `app/api/mcp/health/route.ts` and
 * `lib/agents/libi-registration.ts` all need the handle, and none of them may
 * pull in `category-b.ts` (the whole boot graph) to get it. `lib/mcp-config.ts`
 * is also imported by the MCP child processes, so nothing here may reach beyond
 * `lib/libi-home.ts`. The handle type is imported as a type only.
 *
 * Kept on `globalThis`, not a module-level `let`: under Next's Turbopack dev
 * server, `instrumentation.ts` (which runs the lifecycle and stores the handle)
 * and an API route (which reads it) can resolve this module to two different
 * instances. A module variable written by one is invisible to the other, so
 * the health route read `null` and reported `"unknown"` while the aggregator
 * was running fine.
 */
import { getCurrentMcpPort, resolveMcpHttpPort } from "@/lib/libi-home";
import type { McpHttpChildHandle } from "./mcp-http-child";

const MCP_HTTP_GLOBAL_KEY = "__libiMcpHttpChild_v1";

const slot = globalThis as unknown as {
  [MCP_HTTP_GLOBAL_KEY]?: McpHttpChildHandle | null;
};

/** The supervisor handle, or null before the `mcp-http` boot step started it (and after shutdown). */
export function getMcpHttpChild(): McpHttpChildHandle | null {
  return slot[MCP_HTTP_GLOBAL_KEY] ?? null;
}

export function setMcpHttpChild(handle: McpHttpChildHandle | null): void {
  slot[MCP_HTTP_GLOBAL_KEY] = handle;
}

/**
 * The aggregator port to put in a URL this process hands out.
 *
 * With a supervisor in this process, it is that supervisor's own answer, in
 * every state. Reading `<LIBI_HOME>/mcp-port` instead was wrong exactly when it
 * mattered: a supervisor that gave up drops the file, and the fallback behind
 * it is the default port, 3457, which the desktop app and `npx` both prefer. On
 * a machine running both, that is usually the OTHER instance's aggregator, so
 * in-app agents called its tools against its home and database.
 *
 * Only a process with no supervisor (an MCP child, or this process before boot
 * reached the step) falls back to the file and the resolver.
 */
export function getLiveMcpPort(): number {
  const handle = getMcpHttpChild();
  return handle ? handle.advertisedPort : getCurrentMcpPort();
}

/**
 * The port a `libi` registration in the user's own agent config should name,
 * to judge one as current or stale.
 *
 * Usually `getLiveMcpPort`. The exception is a first launch that gave up with
 * nothing ever published: its port may be a fallback it moved to while the
 * default was busy, which no registration names. `libi connect` writes the
 * `LIBI_MCP_PORT` pin or the default when there is no port file, and a
 * restart asks the picker, which prefers those same ports, so a registration
 * naming them is not stale.
 */
export function getRegistrationMcpPort(): number {
  const handle = getMcpHttpChild();
  if (handle && handle.publishedPort === null && handle.status() !== "running") return resolveMcpHttpPort();
  return getLiveMcpPort();
}
