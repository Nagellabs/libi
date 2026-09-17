import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Provisioning the two heavy subtrees of a real Libi Home into a scenario's
 * hermetic temp home.
 *
 * The harness gives every run a fresh `mkdtemp` LIBI_HOME, which is what makes
 * a scenario deterministic — and also what makes a whole class of scenario
 * impossible: `uv` lives in `<home>/bin` and model weights in `<home>/models`,
 * so anything that needs local Whisper or local ACE-Step can only ever assert
 * `needs_install`. The obvious fix — symlink `~/.libi/bin` and
 * `~/.libi/models` into the temp home, the way `lib/dev/worktree-bootstrap.ts`
 * does — is NOT safe here. A symlink is not read-only: a boot that
 * re-provisions a dependency, or a model download, writes straight through it
 * into the user's real Libi Home, which nothing in this repo is allowed to do.
 * The worktree bootstrap gets away with it because sharing is its intent; an
 * eval harness that can corrupt the user's home is a worse trade than a
 * harness that skips two scenarios.
 *
 * So the share is a COPY, and the read-only guarantee is structural rather
 * than a convention: after `provisionSharedDeps` returns, nothing the run does
 * can reach the source, because there is no path from the temp home back to
 * it. On APFS (`cp -c`) and on a reflink-capable Linux filesystem the copy is
 * copy-on-write — measured at 8 GB of `models` in 25 ms, consuming no extra
 * space until something writes — and where the filesystem cannot clone, it
 * degrades to a plain recursive copy, which is slower but has the same
 * guarantee.
 *
 * Opt-in per scenario (`share:` frontmatter), because it is not free of
 * consequence: a scenario written against an empty home asserts the
 * `needs_install` path, and handing it `bin/uv` changes what the agent can do.
 */

/** The only subtrees a scenario may ask for. Not a prefix match, not a path. */
export const SHAREABLE = ["bin", "models"] as const;
export type Shareable = (typeof SHAREABLE)[number];

export function isShareable(name: string): name is Shareable {
  return (SHAREABLE as readonly string[]).includes(name);
}

/** The user's real Libi Home — the source, read and never written. */
export function canonicalLibiHome(): string {
  return join(homedir(), ".libi");
}

/** `cp` invocation that prefers a copy-on-write clone on this platform. */
function cloneArgs(src: string, dest: string): string[][] {
  const cow =
    process.platform === "darwin"
      ? ["-Rc", src, dest] // APFS clonefile; fails outright when unsupported
      : ["-R", "--reflink=always", src, dest];
  return [cow, ["-R", src, dest]];
}

/**
 * Remove any symlink in the freshly copied tree that points outside it. `cp -R`
 * copies symlinks as symlinks, so a link in the source pointing back at the
 * canonical home would be a writable path straight out of the sandbox — the
 * exact hole this module exists to close. There are none today; this keeps the
 * guarantee structural rather than an observation about today's `~/.libi`.
 */
function scrubEscapingLinks(dir: string, root: string): number {
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = resolve(dir, readlinkSync(p));
      if (target !== root && !target.startsWith(root + "/")) {
        rmSync(p, { force: true });
        removed++;
      }
      continue;
    }
    if (entry.isDirectory()) removed += scrubEscapingLinks(p, root);
  }
  return removed;
}

export interface ProvisionResult {
  /** Subtrees materialised into the temp home. */
  shared: Shareable[];
  /** True when a copy-on-write clone was used for every one of them. */
  cow: boolean;
  /** Escaping symlinks removed from the copies (expected to be 0). */
  scrubbed: number;
}

/**
 * Materialise `share` from `sourceHome` into `home`. Throws — loudly, rather
 * than running the scenario against an empty home and reporting a result —
 * when a requested subtree does not exist on this machine.
 */
export function provisionSharedDeps(opts: {
  home: string;
  share: readonly string[];
  /** Defaults to `~/.libi`. Injected in tests; NEVER written to. */
  sourceHome?: string;
}): ProvisionResult {
  const result: ProvisionResult = { shared: [], cow: true, scrubbed: 0 };
  if (opts.share.length === 0) return result;

  const sourceHome = opts.sourceHome ?? canonicalLibiHome();
  for (const name of opts.share) {
    if (!isShareable(name)) {
      throw new Error(
        `skill-eval: cannot share "${name}" — only ${SHAREABLE.join(" / ")} may be shared into a scenario home.`,
      );
    }
    const src = join(sourceHome, name);
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      throw new Error(
        `skill-eval: this scenario asks to share "${name}", but ${src} does not exist. ` +
          "Provision it in the real Libi Home first (boot libi once), or drop it from the scenario's `share:`.",
      );
    }
    const dest = join(opts.home, name);
    const [cow, plain] = cloneArgs(src, dest);
    try {
      execFileSync("cp", cow, { stdio: "ignore" });
    } catch {
      // No copy-on-write on this filesystem. A plain copy carries the same
      // isolation guarantee; it just costs real bytes and real time.
      result.cow = false;
      rmSync(dest, { recursive: true, force: true });
      execFileSync("cp", plain, { stdio: "ignore" });
    }
    if (lstatSync(dest).isSymbolicLink()) {
      rmSync(dest, { force: true });
      // The source itself was a link (a worktree home, say) — a link is
      // exactly what must not survive into the sandbox.
      throw new Error(`skill-eval: refusing to share ${src} — it is a symlink, not a real directory.`);
    }
    result.scrubbed += scrubEscapingLinks(dest, resolve(dest));
    result.shared.push(name);
  }
  return result;
}
