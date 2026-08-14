// __tests__/integration/storyboard/render-isolation.test.ts
//
// Proves the RC-C fix: storyboard sketch rendering runs in a permission-
// restricted CHILD PROCESS, so an untrusted draw body can no longer (a) execute
// in the Next.js server process, or (b) write files even if it bypasses the
// validator denylist. Spawns real subprocesses — no app boot required.

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { renderUnitToPng } from "@/lib/storyboard/render";
import { validateDrawFunction } from "@/lib/ai/scene-validator";

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

const FRAME = { width: 80, height: 120 };

// Resolve the tmp dir's realpath — on macOS os.tmpdir() may contain a symlink
// (/tmp → /private/tmp, /var → /private/var) and Node's permission model keys
// on the resolved real path.
const TMP = fs.realpathSync(os.tmpdir());

const cleanup: string[] = [];
function tmpFile(): string {
  const p = path.join(TMP, `libi-render-pwn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cleanup.push(p);
  return p;
}

afterEach(() => {
  for (const p of cleanup.splice(0)) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
});

function permissionFlag(): string {
  const [major, minor] = process.version.replace(/^v/, "").split(".").map(Number);
  if (major > 20 || (major === 20 && minor >= 6)) return "--permission";
  return "--experimental-permission";
}

describe("storyboard render isolation (RC-C)", () => {
  it("renders a benign canvas body to a real PNG", async () => {
    const png = await renderUnitToPng("canvas", `context.ctx.fillRect(0,0,10,10);`, FRAME);
    expect(isPng(png)).toBe(true);
  });

  it("renders a benign satori body to a real PNG", async () => {
    const png = await renderUnitToPng(
      "satori",
      `return h("div", { style: { width: "100%", height: "100%", display: "flex", background: "#123" } }, "ok");`,
      FRAME,
    );
    expect(isPng(png)).toBe(true);
  });

  it("renders a benign svg body to a real PNG", async () => {
    const png = await renderUnitToPng(
      "svg",
      `return '<svg xmlns="http://www.w3.org/2000/svg" width="' + context.width + '" height="' + context.height + '"><rect width="100%" height="100%" fill="#345"/></svg>';`,
      FRAME,
    );
    expect(isPng(png)).toBe(true);
  });

  it("rejects a body that uses a denylisted require() and writes nothing", async () => {
    const target = tmpFile();
    const body = `require('fs').writeFileSync(${JSON.stringify(target)}, 'x');`;
    await expect(renderUnitToPng("canvas", body, FRAME)).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it("rejects the constructor.constructor Function-escape and writes nothing", async () => {
    const target = tmpFile();
    const body = `[].constructor.constructor("require('fs').writeFileSync(${JSON.stringify(
      target,
    ).replace(/"/g, '\\"')}, 'x')")();`;
    await expect(renderUnitToPng("canvas", body, FRAME)).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  // END-TO-END proof of the LAST line of defense THROUGH the real production
  // entry (`renderUnitToPng` → spawned worker): a body that slips PAST the
  // validator denylist (it reaches `fs` via `this["pro"+"cess"].getBuiltinModule`
  // — no `require`/`process`/`Function`/`fetch` token for the regex to catch) and
  // actually calls `fs.writeFileSync`. The write is denied by the permission
  // model (not the denylist), so the body throws ERR_ACCESS_DENIED, the promise
  // rejects, and the sentinel file is never created. This proves the wiring: the
  // worker is genuinely spawned with the fs-write-denying flags.
  it("permission-model backstop e2e: a denylist-bypassing write is blocked through renderUnitToPng", async () => {
    const target = tmpFile();
    // Reaches fs WITHOUT any denylisted token: `this` is globalThis inside the
    // sloppy-mode `new Function` body; the split string "pro"+"cess" dodges both
    // the bare-`process` and `['process'`-literal denylist rules;
    // `getBuiltinModule` needs no `require(`.
    const body = [
      'var proc = this["pro" + "cess"];',
      'var fs = proc.getBuiltinModule("fs");',
      `try { fs.writeFileSync(${JSON.stringify(target)}, "x"); }`,
      'catch (e) { throw new Error("WRITE_BLOCKED:" + (e && e.code)); }',
    ].join("\n");

    // Sanity: this body must actually get PAST the validator (else we'd only be
    // re-proving the denylist, not the permission model).
    expect(validateDrawFunction(body).valid).toBe(true);

    await expect(renderUnitToPng("canvas", body, FRAME)).rejects.toThrow(
      /WRITE_BLOCKED:ERR_ACCESS_DENIED/,
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  // Direct proof of the LAST line of defense: even a process that reaches
  // `fs.writeFileSync` (bypassing the denylist entirely) cannot write to disk
  // under the exact permission flags the render worker is spawned with.
  it("permission-model backstop: fs.writeFileSync is denied under the worker's flags", () => {
    const target = tmpFile();
    const probe = path.join(TMP, `libi-probe-${Date.now()}.mjs`);
    cleanup.push(probe);
    fs.writeFileSync(
      probe,
      `import fs from "fs";
try { fs.writeFileSync(${JSON.stringify(target)}, "x"); process.stdout.write("WROTE"); }
catch (e) { process.stdout.write("DENIED:" + e.code); }
`,
    );
    const res = spawnSync(
      process.execPath,
      [permissionFlag(), "--allow-addons", `--allow-fs-read=${TMP}`, "--no-warnings", probe],
      { encoding: "utf8" },
    );
    expect(res.stdout).toContain("DENIED:ERR_ACCESS_DENIED");
    expect(fs.existsSync(target)).toBe(false);
  });
});
