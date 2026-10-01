import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EL-3 (Windows F1): closing a terminal in the packaged Windows app forked a
 * second Libi.exe. node-pty 1.1.0's ConPTY kill path WITHOUT `useConptyDll`
 * collects the console's process list by `child_process.fork(
 * conpty_console_list_agent.js)`; inside Electron main `fork` runs Libi.exe with
 * ELECTRON_RUN_AS_NODE=1, which the `runAsNode: false` fuse ignores — so it
 * booted the app, lost the single-instance lock, and node-pty waited 5 s. With
 * `useConptyDll: true` the kill closes the pseudoconsole and forks nothing
 * (node_modules/node-pty/lib/windowsPtyAgent.js#kill).
 *
 * `node-pty` is mocked; what is under test is the option `realPtyFactory`
 * hands to `spawn`, per platform. The platform is pinned INSIDE each test —
 * CI is ubuntu, and `lib/platform.ts` reads `os.platform()`, which is
 * `process.platform`.
 */
const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: h.spawn }));

import { realPtyFactory } from "@/lib/terminal/pty";
import type { PtySpawnOpts } from "@/lib/terminal/types";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function pinPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

const fakePty = () => ({
  pid: 4242,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
});

const opts: Omit<PtySpawnOpts, "purpose"> = { cwd: "/tmp", cols: 80, rows: 24, env: { ...process.env, PATH: "/usr/bin" } };

beforeEach(() => {
  h.spawn.mockReset();
  h.spawn.mockImplementation(fakePty);
});
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
});

describe("realPtyFactory spawn options", () => {
  it("win32: chat and setup terminals spawn with useConptyDll: true (node-pty's fork-free kill path)", () => {
    pinPlatform("win32");
    for (const purpose of ["chat", "setup"] as const) {
      h.spawn.mockClear();
      realPtyFactory({ ...opts, purpose });
      expect(h.spawn).toHaveBeenCalledTimes(1);
      const [shell, , spawnOpts] = h.spawn.mock.calls[0];
      expect(shell).toBe("powershell.exe");
      expect(spawnOpts).toMatchObject({ useConptyDll: true, name: "xterm-256color", cwd: "/tmp", cols: 80, rows: 24 });
    }
  });

  it.each(["darwin", "linux"] as const)("%s: the option is absent", (platform) => {
    pinPlatform(platform);
    realPtyFactory({ ...opts, purpose: "chat" });
    const [, , spawnOpts] = h.spawn.mock.calls[0];
    expect(spawnOpts).not.toHaveProperty("useConptyDll");
  });

  it("kill() goes straight to node-pty's kill (the wrapper adds no process-list walk of its own)", () => {
    pinPlatform("win32");
    const pty = realPtyFactory({ ...opts, purpose: "chat" });
    const inner = h.spawn.mock.results[0].value as ReturnType<typeof fakePty>;
    pty.kill();
    expect(inner.kill).toHaveBeenCalledTimes(1);
  });
});
