import type { DependencyStatus } from "@/mcp/registry/types";

export function hasInstallFailure(
  server: { installStatus: string },
  deps: DependencyStatus[] | undefined,
): boolean {
  if (server.installStatus === "failed") {
    return true;
  }

  if (!deps || deps.length === 0) {
    return false;
  }

  return deps.some((dep) => dep.runtimeStatus === "failed");
}
