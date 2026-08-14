// __tests__/unit/storyboard/render/index.test.ts
import { describe, it, expect } from "vitest";
import { renderUnitToPng, sanitizeWorkerEnv } from "@/lib/storyboard/render";

const isPng = (b: Buffer) =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const FRAME = { width: 100, height: 160 };

// Each render spawns a permission-restricted subprocess (RC-C isolation, Task 5b)
// that cold-loads the tsx runtime + satori/@napi-rs/canvas, so a single render can
// take several seconds — well past vitest's 5s default. Give the spawning tests a
// generous timeout. (Perf follow-up: pool a warm worker to amortize cold-start.)
const RENDER_TIMEOUT = 30_000;

describe("renderUnitToPng dispatcher", () => {
  it("renders canvas mode", async () => {
    const png = await renderUnitToPng("canvas", `context.ctx.fillRect(0,0,10,10);`, FRAME);
    expect(isPng(png)).toBe(true);
  }, RENDER_TIMEOUT);
  it("renders svg mode", async () => {
    const png = await renderUnitToPng(
      "svg",
      `return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="160"><rect width="100%" height="100%" fill="#345"/></svg>';`,
      FRAME,
    );
    expect(isPng(png)).toBe(true);
  }, RENDER_TIMEOUT);
  it("renders satori mode", async () => {
    const png = await renderUnitToPng(
      "satori",
      `return h("div", { style: { width:"100%", height:"100%", display:"flex", background:"#123" } });`,
      FRAME,
    );
    expect(isPng(png)).toBe(true);
  }, RENDER_TIMEOUT);
  it("passes extra context into the satori render unit", async () => {
    // A unit that reads context.blocks to build its element — proves extra reaches the fn.
    const source = `return h("div", { style: { display: "flex", width: "100%", height: "100%" } }, String(context.blocks.length));`;
    const png = await renderUnitToPng(
      "satori",
      source,
      FRAME,
      { blocks: [{ id: "b1", kind: "subject", label: "x", rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 1 }] },
    );
    expect(isPng(png)).toBe(true);
  }, RENDER_TIMEOUT);
  it("rejects a body with a disallowed pattern", async () => {
    await expect(
      renderUnitToPng("canvas", `fetch("http://evil");`, FRAME),
    ).rejects.toThrow();
  });
  it("rejects an unknown kind", async () => {
    // @ts-expect-error testing runtime guard
    await expect(renderUnitToPng("webgl", `x`, FRAME)).rejects.toThrow();
  });
});

describe("sanitizeWorkerEnv", () => {
  it("strips provider secrets from the worker env", () => {
    const env = sanitizeWorkerEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      NODE_ENV: "test",
      TSX_DISABLE_CACHE: "1",
      LIBI_HOME: "/home/x/.libi",
      TMPDIR: "/tmp",
      FAL_KEY: "sk-fal-secret",
      FAL_AI_KEY: "sk-fal-ai-secret",
      FAL_API_KEY_ADMIN_SCOPE: "sk-admin",
      ELEVENLABS_API_KEY: "el-secret",
      OPENAI_API_KEY: "oa-secret",
      ANTHROPIC_API_KEY: "an-secret",
      GITHUB_TOKEN: "gh-secret",
      git_token: "git-secret",
      SOME_CUSTOM_SECRET: "sh",
      SOME_CUSTOM_TOKEN: "tk",
    });
    // secrets gone
    expect(env.FAL_KEY).toBeUndefined();
    expect(env.FAL_AI_KEY).toBeUndefined();
    expect(env.FAL_API_KEY_ADMIN_SCOPE).toBeUndefined();
    expect(env.ELEVENLABS_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.git_token).toBeUndefined();
    expect(env.SOME_CUSTOM_SECRET).toBeUndefined();
    expect(env.SOME_CUSTOM_TOKEN).toBeUndefined();
    // everything the worker needs is kept
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.NODE_ENV).toBe("test");
    expect(env.TSX_DISABLE_CACHE).toBe("1");
    expect(env.LIBI_HOME).toBe("/home/x/.libi");
    expect(env.TMPDIR).toBe("/tmp");
  });

  it("allowlists env: drops an unknown non-secret key (not just secret-shaped ones)", () => {
    const env = sanitizeWorkerEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      NODE_ENV: "test",
      TSX_DISABLE_CACHE: "1",
      LIBI_HOME: "/home/x/.libi",
      TMPDIR: "/tmp",
      // an unanticipated NON-secret-shaped key: a denylist would let it through,
      // an allowlist must drop it.
      SOME_NEW_KEY: "x",
      // a secret-shaped key stays dropped by the second-layer denylist too.
      FAL_KEY: "sk-secret",
    });
    // allowlist drops the unknown key entirely
    expect(env.SOME_NEW_KEY).toBeUndefined();
    // secret still gone (belt-and-braces)
    expect(env.FAL_KEY).toBeUndefined();
    // allowlisted runtime keys survive
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.NODE_ENV).toBe("test");
    expect(env.TSX_DISABLE_CACHE).toBe("1");
    expect(env.LIBI_HOME).toBe("/home/x/.libi");
    expect(env.TMPDIR).toBe("/tmp");
  });
});
