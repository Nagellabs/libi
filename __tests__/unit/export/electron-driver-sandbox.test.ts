import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DRIVER = path.resolve(__dirname, "../../../lib/export/drivers/electron.ts");

describe("the hidden Electron export window is sandboxed (spec §4.6)", () => {
  it("declares sandbox: true, contextIsolation: true, nodeIntegration: false and no preload", () => {
    const src = fs.readFileSync(DRIVER, "utf-8");
    const start = src.indexOf("webPreferences: {");
    expect(start).toBeGreaterThan(-1);
    const prefs = src.slice(start, src.indexOf("}", start));
    expect(prefs).toMatch(/sandbox:\s*true/);
    expect(prefs).toMatch(/contextIsolation:\s*true/);
    expect(prefs).toMatch(/nodeIntegration:\s*false/);
    expect(prefs).not.toMatch(/preload/);
    // One BrowserWindow in the driver — no second, unsandboxed one.
    expect(src.match(/new BrowserWindow\(/g)).toHaveLength(1);
  });
});
