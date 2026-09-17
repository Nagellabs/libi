/**
 * The scenario home may reuse a real Libi Home's `bin` / `models`, and
 * the source must be UNREACHABLE from the run afterwards.
 *
 * The follow-up proposed symlinking them in, the way the worktree bootstrap
 * does. A symlink is not read-only: a dependency re-provision or a model
 * download during the run writes straight through it into `~/.libi`. So the
 * share is a copy, and these tests pin the property that makes it safe — a
 * write inside the scenario home never reaches the source — rather than the
 * mechanism that makes it cheap (APFS / reflink clone, which is invisible
 * here by design and degrades to a plain copy where it is unavailable).
 *
 * Never points at the real `~/.libi`: `sourceHome` is a fixture, and the
 * assertions below are exactly what would fail if this ever wrote to it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionSharedDeps, SHAREABLE, isShareable } from "@/scripts/skill-eval/shared-deps";

let root: string;
let source: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "libi-shared-deps-"));
  source = join(root, "canonical-home");
  home = join(root, "scenario-home");
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(join(source, "models", "whisper"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(source, "bin", "uv"), "#!/bin/sh\n");
  writeFileSync(join(source, "models", "whisper", "small.bin"), "weights");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("provisionSharedDeps", () => {
  it("materialises the requested subtrees into the scenario home", () => {
    const res = provisionSharedDeps({ home, share: ["bin", "models"], sourceHome: source });
    expect(res.shared).toEqual(["bin", "models"]);
    expect(readFileSync(join(home, "bin", "uv"), "utf8")).toBe("#!/bin/sh\n");
    expect(readFileSync(join(home, "models", "whisper", "small.bin"), "utf8")).toBe("weights");
  });

  it("is a COPY: writing, replacing and deleting in the scenario home never touches the source", () => {
    provisionSharedDeps({ home, share: ["bin", "models"], sourceHome: source });

    writeFileSync(join(home, "bin", "uv"), "REPLACED");
    writeFileSync(join(home, "bin", "yt-dlp"), "new");
    rmSync(join(home, "models", "whisper", "small.bin"));

    expect(readFileSync(join(source, "bin", "uv"), "utf8")).toBe("#!/bin/sh\n");
    expect(readdirSync(join(source, "bin"))).toEqual(["uv"]);
    expect(readFileSync(join(source, "models", "whisper", "small.bin"), "utf8")).toBe("weights");
  });

  it("leaves no symlink pointing out of the scenario home", () => {
    // `cp -R` copies a symlink AS a symlink, so a link in the source pointing
    // back at the canonical home would be a writable path out of the sandbox.
    symlinkSync(join(source, "models"), join(source, "bin", "escape"));
    const res = provisionSharedDeps({ home, share: ["bin"], sourceHome: source });
    expect(res.scrubbed).toBe(1);
    expect(readdirSync(join(home, "bin"))).toEqual(["uv"]);
  });

  it("does nothing at all when the scenario asked for nothing", () => {
    expect(provisionSharedDeps({ home, share: [], sourceHome: source }).shared).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it("refuses a name outside the allowlist", () => {
    expect(() =>
      provisionSharedDeps({ home, share: ["logs"], sourceHome: source }),
    ).toThrow(/only bin \/ models/);
    expect(() =>
      provisionSharedDeps({ home, share: ["../.ssh"], sourceHome: source }),
    ).toThrow(/only bin \/ models/);
    expect(SHAREABLE).toEqual(["bin", "models"]);
    expect(isShareable("bin")).toBe(true);
    expect(isShareable("uv")).toBe(false);
  });

  it("fails loudly when the machine has no such subtree, rather than booting without it", () => {
    rmSync(join(source, "models"), { recursive: true });
    expect(() =>
      provisionSharedDeps({ home, share: ["models"], sourceHome: source }),
    ).toThrow(/does not exist/);
  });

  it("refuses a source that is itself a symlink", () => {
    const linked = join(root, "linked-home");
    mkdirSync(linked);
    symlinkSync(join(source, "bin"), join(linked, "bin"));
    expect(() => provisionSharedDeps({ home, share: ["bin"], sourceHome: linked })).toThrow(
      /symlink, not a real directory/,
    );
  });
});
