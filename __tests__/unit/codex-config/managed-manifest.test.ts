import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach } from "vitest";
import {
  readManagedNames,
  writeManagedNames,
} from "@/lib/codex-config/managed-manifest";

const tempDirs: string[] = [];

function tmpCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-codex-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MANIFEST = ".libi-managed-mcps.json";

describe("readManagedNames", () => {
  it("returns an empty set when the manifest is missing", () => {
    const home = tmpCodexHome();
    expect(readManagedNames(home)).toEqual(new Set());
  });

  it("returns an empty set when the manifest JSON is malformed", () => {
    const home = tmpCodexHome();
    fs.writeFileSync(path.join(home, MANIFEST), "{not valid json");
    expect(readManagedNames(home)).toEqual(new Set());
  });

  it("returns an empty set when the shape is wrong (managed not an array)", () => {
    const home = tmpCodexHome();
    fs.writeFileSync(path.join(home, MANIFEST), JSON.stringify({ managed: "libi" }));
    expect(readManagedNames(home)).toEqual(new Set());
  });

  it("reads names from a well-formed manifest, filtering non-strings", () => {
    const home = tmpCodexHome();
    fs.writeFileSync(
      path.join(home, MANIFEST),
      JSON.stringify({ managed: ["libi", "falc", 42, null] }),
    );
    expect(readManagedNames(home)).toEqual(new Set(["libi", "falc"]));
  });
});

describe("writeManagedNames", () => {
  it("writes { managed: [...] } sorted", () => {
    const home = tmpCodexHome();
    writeManagedNames(home, new Set(["zebra", "alpha", "libi"]));
    const raw = fs.readFileSync(path.join(home, MANIFEST), "utf-8");
    expect(JSON.parse(raw)).toEqual({ managed: ["alpha", "libi", "zebra"] });
  });

  it("round-trips through read", () => {
    const home = tmpCodexHome();
    const names = new Set(["libi", "falc", "youtube"]);
    writeManagedNames(home, names);
    expect(readManagedNames(home)).toEqual(names);
  });

  it("writes an empty manifest for an empty set", () => {
    const home = tmpCodexHome();
    writeManagedNames(home, new Set());
    expect(readManagedNames(home)).toEqual(new Set());
    expect(JSON.parse(fs.readFileSync(path.join(home, MANIFEST), "utf-8"))).toEqual({
      managed: [],
    });
  });
});
