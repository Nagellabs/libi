import { describe, it, expect } from "vitest";

import {
  createRendererConsoleForwarder,
  RENDERER_CONSOLE_MAX_LINES,
  RENDERER_CONSOLE_MAX_MESSAGE_CHARS,
  type RendererConsoleMessage,
} from "../../../electron/sync-log";

// Renderer `console.error` → electron-main-sync.log (electron/main.ts wires
// this on `webContents.on("console-message")`).
//
// Why it exists: Next's `[browser]` relay into server.log is a DEV-SERVER
// feature (next/dist/server/dev/browser-logs/) — in production nothing puts
// renderer console output on disk, and the packaged app is the one
// environment where the user also has no DevTools and no terminal. These
// tests pin the forwarder's three deliberate narrowings: errors only, message
// truncation, and a hard cap so an error thrown per animation frame can't
// grow the log unboundedly through appendFileSync.

function msg(overrides: Partial<RendererConsoleMessage>): RendererConsoleMessage {
  return {
    level: "error",
    message: "boom",
    sourceId: "http://localhost:3000/_next/static/chunks/app.js",
    lineNumber: 42,
    ...overrides,
  };
}

describe("createRendererConsoleForwarder", () => {
  it("forwards console.error with message, source and line", () => {
    const lines: string[] = [];
    const forward = createRendererConsoleForwarder((l) => lines.push(l));

    forward(msg({ message: "Uncaught TypeError: x is not a function" }));

    expect(lines).toEqual([
      "renderer console.error: Uncaught TypeError: x is not a function (http://localhost:3000/_next/static/chunks/app.js:42)",
    ]);
  });

  it("ignores info, warning and debug — errors only, by design", () => {
    const lines: string[] = [];
    const forward = createRendererConsoleForwarder((l) => lines.push(l));

    forward(msg({ level: "info" }));
    forward(msg({ level: "warning" }));
    forward(msg({ level: "debug" }));

    expect(lines).toEqual([]);
  });

  it("omits the source suffix when sourceId is empty", () => {
    const lines: string[] = [];
    const forward = createRendererConsoleForwarder((l) => lines.push(l));

    forward(msg({ sourceId: "", lineNumber: 0 }));

    expect(lines).toEqual(["renderer console.error: boom"]);
  });

  it("truncates oversized messages and says how much was cut", () => {
    const lines: string[] = [];
    const forward = createRendererConsoleForwarder((l) => lines.push(l));
    const huge = "x".repeat(RENDERER_CONSOLE_MAX_MESSAGE_CHARS + 500);

    forward(msg({ message: huge }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("… [truncated 500 chars]");
    // The kept prefix is exactly the cap, not the whole message.
    expect(lines[0]).toContain("x".repeat(RENDERER_CONSOLE_MAX_MESSAGE_CHARS));
    expect(lines[0]).not.toContain("x".repeat(RENDERER_CONSOLE_MAX_MESSAGE_CHARS + 1));
  });

  it("goes silent after the cap, with one final suppression line", () => {
    const lines: string[] = [];
    const forward = createRendererConsoleForwarder((l) => lines.push(l));

    for (let i = 0; i < RENDERER_CONSOLE_MAX_LINES + 100; i++) {
      forward(msg({ message: `err ${i}` }));
    }

    expect(lines).toHaveLength(RENDERER_CONSOLE_MAX_LINES);
    expect(lines[RENDERER_CONSOLE_MAX_LINES - 1]).toContain(
      "further renderer errors suppressed",
    );
    // Nothing after the suppression line, no matter how many more arrive.
    expect(lines.filter((l) => l.includes("err ")).length).toBe(
      RENDERER_CONSOLE_MAX_LINES - 1,
    );
  });

  it("non-error messages do not consume the cap", () => {
    const lines: string[] = [];
    const forward = createRendererConsoleForwarder((l) => lines.push(l));

    for (let i = 0; i < RENDERER_CONSOLE_MAX_LINES; i++) {
      forward(msg({ level: "warning" }));
    }
    forward(msg({ message: "still alive" }));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("still alive");
  });
});
