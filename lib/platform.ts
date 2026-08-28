import os from "node:os";

/**
 * Runtime platform predicates for code that ends up in the Next server bundle.
 *
 * **Use these instead of `process.platform === "win32"` in anything the Next
 * build compiles.** That comparison is not a runtime check in the shipped
 * product: Turbopack constant-folds `process.platform === "<literal>"` against
 * the BUILD machine's platform and drops the dead branch, so a package built
 * on macOS ships a server that believes it is on macOS forever.
 *
 * That is not theoretical. In the published 0.1.4 it produced, verbatim:
 *
 *   getBinaryPath(e){return i.default.join((0,d.getLibiBinDir)(),e)}
 *   let{shell:t,args:i}={shell:process.env.SHELL||"/bin/zsh",args:["-l"]}
 *
 * — so on Windows the server looked for `bin/uv` while the installer had
 * written `bin/uv.exe` (no bundled MCP ever probed UP), and the terminal panel
 * tried to spawn `/bin/zsh`. The `powershell.exe` branch was not merely
 * unreachable; it was absent from the bundle.
 *
 * Two things defeat the fold, and both are used here deliberately:
 *   1. `os.platform()` is a CALL. The bundler has no static value for it,
 *      where `process.platform` is a property it happily assumes.
 *   2. `switch` is left alone even over `process.platform` — `lib/export/
 *      folder.ts` survived 0.1.4 intact for exactly that reason, which is how
 *      the mechanism was identified.
 *
 * `dist-cli` (esbuild) never had this problem, which is why Category A wrote
 * the correct filenames while the server looked for the wrong ones — one
 * package, two compilers, two answers.
 */
function currentPlatform(): NodeJS.Platform {
  return os.platform();
}

export function isWindows(): boolean {
  switch (currentPlatform()) {
    case "win32":
      return true;
    default:
      return false;
  }
}

export function isMac(): boolean {
  switch (currentPlatform()) {
    case "darwin":
      return true;
    default:
      return false;
  }
}

export function isLinux(): boolean {
  switch (currentPlatform()) {
    case "linux":
      return true;
    default:
      return false;
  }
}

/** `.exe` on Windows, `""` elsewhere — the suffix for a native executable. */
export function exeSuffix(): string {
  return isWindows() ? ".exe" : "";
}
