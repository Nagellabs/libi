import { NextResponse } from "next/server";
import { DependencyManager } from "@/mcp/registry/dependency-manager";
import {
  ensureBootstrapped,
  getVirtualDepsForMcp,
} from "@/lib/mcp-virtual-deps/registry";
import { serverLogger as logger } from "@/lib/logger";
import {
  markInstalling,
  clearInstalling,
} from "@/lib/mcp-virtual-deps/in-flight";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { binary?: string };
  if (!body.binary || typeof body.binary !== "string") {
    return NextResponse.json({ error: "binary required" }, { status: 400 });
  }
  const binary = body.binary;

  // Try virtual-dep registry first. The chip's `binary` field is the
  // virtual dep's `label`; we also accept `id` matches for robustness.
  ensureBootstrapped();
  const virtual = getVirtualDepsForMcp(id).find(
    (d) => d.id === binary || d.label === binary,
  );
  if (virtual) {
    // Fire-and-forget: install may take minutes (model downloads, env
    // warm-ups). UI polls dependencyStatus for live state. Mark the dep
    // as in-flight so inspect() returns runtimeStatus: "installing" until
    // install() resolves (or rejects).
    markInstalling(virtual.id);
    virtual.install()
      .catch((err) => {
        logger.warn(
          { mcpId: id, virtualDepId: virtual.id, err: err instanceof Error ? err.message : String(err) },
          "virtual-dep install failed",
        );
      })
      .finally(() => clearInstalling(virtual.id));
    return NextResponse.json({ accepted: true, kind: "virtual", id: virtual.id });
  }

  // Fall through to the existing binary-dep retry path. retryDep already
  // persists "failed" state to the DB before it rethrows, so swallowing
  // here just prevents an unhandled rejection.
  const manager = new DependencyManager();
  manager.retryDep(id, binary).catch((err) => {
    logger.warn(
      { mcpId: id, binary, err: err instanceof Error ? err.message : String(err) },
      "retryDep failed (state persisted)",
    );
  });
  return NextResponse.json({ accepted: true, kind: "binary" });
}
