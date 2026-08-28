import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { isMac, isWindows } from "@/lib/platform";

/**
 * Open the OS file manager at a given path. Used as a fallback when the
 * Electron preload bridge isn't available (BYO-CLI / web preview).
 *
 * Path-traversal guard: the resolved absolute path must live inside the
 * user's home directory (or the OS temp dir). Anything else is silently
 * ignored — no reveal is performed.
 *
 * Non-oracle response (RC-A defense-in-depth): once the request body is
 * well-formed, this route returns the SAME `{ ok: true }` / 200 response
 * regardless of whether the path exists, is a directory, lives outside the
 * allowed roots, or the OS reveal command fails. A real reveal of a
 * legitimate same-origin path still opens the file manager, but the
 * response never distinguishes those cases — so it cannot be used as an
 * existence oracle to probe which files/dirs exist under $HOME. Cross-origin
 * abuse is already blocked upstream by the CSRF/Origin middleware (RC-A).
 */
export async function POST(req: Request): Promise<Response> {
  let body: { path?: string };
  try {
    body = (await req.json()) as { path?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const raw = body.path;
  if (!raw || typeof raw !== "string") {
    return NextResponse.json({ error: "Missing path" }, { status: 400 });
  }

  // Best-effort reveal. Every branch below is swallowed so the response
  // shape/status is identical for existing vs missing vs out-of-bounds
  // paths — see the doc comment above.
  try {
    const abs = path.resolve(raw);
    const home = os.homedir();
    const tmp = os.tmpdir();
    // Only reveal paths under $HOME OR the OS temp dir that actually exist.
    // Any other path is quietly skipped (no reveal, no distinguishable error).
    if ((abs.startsWith(home) || abs.startsWith(tmp)) && fs.existsSync(abs)) {
      // On macOS, `open -R <path>` reveals the file in Finder. Windows + Linux
      // don't have a native "reveal" — fall back to opening the containing folder.
      // isMac()/isWindows(), not a `const platform = process.platform` alias —
      // see lib/platform.ts. The bundler folds THROUGH such an alias: this
      // block compiled down to `(process.platform, spawn("open", ["-R", e]))`
      // in a real build, with the Windows and Linux branches deleted outright,
      // so "reveal in folder" ran `open -R` on Windows.
      if (isMac()) {
        spawn("open", ["-R", abs], { detached: true, stdio: "ignore" }).unref();
      } else if (isWindows()) {
        spawn("explorer.exe", [`/select,${abs}`], { detached: true, stdio: "ignore" }).unref();
      } else {
        const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
        spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
      }
    }
  } catch {
    // Swallow — a reveal failure must not leak via a differing response.
  }

  return NextResponse.json({ ok: true });
}
