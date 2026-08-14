import { NextResponse } from "next/server";
import { runEngineSelftest } from "@/lib/tracking/engine-selftest";
import { trackingEngineInstalled } from "@/lib/tracking/not-installed";
import { markDepInstalled } from "@/lib/dependencies/require-deps";
import { serverLogger as logger } from "@/lib/logger";

export async function GET() {
  if (!trackingEngineInstalled()) {
    return NextResponse.json({ ok: false, installed: false, missing: ["tracking-pyenv"], versions: {} });
  }
  try {
    const st = await runEngineSelftest();
    if (st.ok) {
      // Close the lazy-install loop: the engine is genuinely installed
      // (token marker present + selftest passes), so persist tracking-pyenv
      // as installed on the `libi` row — the SAME dependencyStatus JSON the
      // `computeObjectTrack` gate reads via requireDeps("libi", [...]). Tier-2
      // deps are never auto-verified at boot, so without this verify_install
      // would report ok while the gate stayed blocked (requiring a manual
      // sqlite patch). Idempotent + preserves sibling deps.
      try {
        const wrote = markDepInstalled("libi", "tracking-pyenv");
        logger.info(
          { tag: "tracking-pyenv", op: "verify_persist", wrote },
          "verify_install persisted tracking-pyenv installed on libi row",
        );
      } catch (e) {
        // Non-fatal: still report the verify result. A failed persist just
        // means the gate stays blocked (the previous behaviour) rather than
        // breaking the verify response.
        logger.warn(
          {
            tag: "tracking-pyenv",
            op: "verify_persist_failed",
            err: e instanceof Error ? e.message : String(e),
          },
          "verify_install could not persist tracking-pyenv dep status",
        );
      }
    }
    return NextResponse.json({ ok: st.ok, installed: true, missing: st.ok ? [] : ["selftest-failed"], versions: st.versions });
  } catch (e) {
    return NextResponse.json({ ok: false, installed: true, missing: ["selftest-error"], versions: {}, error: e instanceof Error ? e.message : String(e) });
  }
}
