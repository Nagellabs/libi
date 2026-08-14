import { describe, it, expect } from "vitest";
import { hashSpec } from "@/lib/uv-env/hash-spec";

describe("hashSpec", () => {
  it("returns a 16-char hex signature", () => {
    expect(hashSpec("3.12", ["librosa==0.11.0", "soundfile"])).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it("is stable across reorderings of the with-specs", () => {
    const a = hashSpec("3.12", ["librosa==0.11.0", "soundfile"]);
    const b = hashSpec("3.12", ["soundfile", "librosa==0.11.0"]);
    expect(a).toBe(b);
  });

  it("changes when the Python version changes", () => {
    expect(hashSpec("3.12", ["librosa==0.11.0"])).not.toBe(
      hashSpec("3.13", ["librosa==0.11.0"]),
    );
  });

  it("changes when a pinned version bumps", () => {
    expect(hashSpec("3.12", ["librosa==0.11.0"])).not.toBe(
      hashSpec("3.12", ["librosa==0.12.0"]),
    );
  });

  it("changes when a new spec is appended", () => {
    expect(hashSpec("3.12", ["librosa==0.11.0"])).not.toBe(
      hashSpec("3.12", ["librosa==0.11.0", "soundfile"]),
    );
  });
});
