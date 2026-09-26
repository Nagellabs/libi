/**
 * Test-only: import a template folder (a committed fixture, or one the
 * skill-eval harness staged under <LIBI_HOME>/fixtures) into this libi.
 * DISABLED by default; requires `LIBI_ENABLE_TEST_ROUTES=1` like
 * /api/e2e/run-tool. The dir must sit under one of two roots — never an
 * arbitrary path, even with the flag on.
 */
import { NextResponse } from "next/server";
import path from "node:path";
import { testRoutesEnabled } from "@/lib/security/test-routes";
import { getLibiHome } from "@/lib/libi-home";
import { importTemplateFolder } from "@/lib/templates/store";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger as logger } from "@/lib/logger";

/**
 * Containment is LEXICAL (resolve + prefix), not realpath, and deliberately so: both roots
 * are places this repo controls — the hermetic temp home the skill-eval harness just made,
 * and a committed fixture directory — and the route is 403 unless the process that spawned
 * this libi opted in. A symlink planted under either root is already a machine where the
 * attacker can write the fixtures themselves. Widen this to a realpath check only if a root
 * ever becomes a directory an untrusted party can write.
 */
function allowedRoots(): string[] {
  return [
    path.resolve(getLibiHome(), "fixtures"),
    path.resolve(process.cwd(), "__tests__/helpers/fixtures/templates"),
  ];
}

export async function POST(req: Request): Promise<Response> {
  if (!testRoutesEnabled()) return NextResponse.json({ error: "test routes disabled" }, { status: 403 });
  let body: { dir?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (typeof body.dir !== "string") return NextResponse.json({ error: "dir required" }, { status: 400 });
  const dir = path.resolve(body.dir);
  if (!allowedRoots().some((root) => dir === root || dir.startsWith(root + path.sep))) {
    return NextResponse.json({ error: "dir outside the fixture roots" }, { status: 400 });
  }
  try {
    const row = await importTemplateFolder(dir, { origin: "local" });
    navigationEmitter.emit("refresh_query", { queryKey: "templates" });
    return NextResponse.json({ templateId: row.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tag: "templates", op: "seed_failed", dir, err: msg }, "seed-template failed");
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
