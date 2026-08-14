import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * RC-G Task 17: the splash BrowserWindow must be isolated like the main window
 * (nodeIntegration off, contextIsolation on, sandboxed) and reach the main
 * process ONLY through the `splash-preload.ts` contextBridge — never via a raw
 * `require("electron")` in the sandboxed renderer.
 *
 * These are static source assertions; the live behavior (splash still renders
 * Category A/B progress and the fatal-error Quit button works) is the coordinator
 * QA check documented in the task report.
 */
const root = process.cwd();
const read = (rel: string) =>
  fs.readFileSync(path.join(root, rel), "utf-8");

describe("splash window isolation (RC-G)", () => {
  const mainTs = read("electron/main.ts");
  const splashHtml = read("electron/splash.html");
  const splashPreload = read("electron/splash-preload.ts");

  it("createSplash disables nodeIntegration", () => {
    expect(mainTs).toMatch(/nodeIntegration:\s*false/);
    // The old insecure form must be gone.
    expect(mainTs).not.toMatch(/nodeIntegration:\s*true,\s*contextIsolation:\s*false/);
  });

  it("createSplash enables contextIsolation and sandbox", () => {
    expect(mainTs).toMatch(/contextIsolation:\s*true/);
    expect(mainTs).toMatch(/sandbox:\s*true/);
  });

  it("createSplash wires the splash preload", () => {
    expect(mainTs).toMatch(/preload:\s*path\.join\(__dirname,\s*"splash-preload\.js"\)/);
  });

  it("splash.html no longer requires electron directly", () => {
    expect(splashHtml).not.toContain('require("electron")');
    expect(splashHtml).not.toContain("ipcRenderer");
  });

  it("splash.html uses the bridged splashAPI (lifecycle + quit)", () => {
    expect(splashHtml).toContain("window.splashAPI");
    expect(splashHtml).toContain("splashAPI.onLifecycle");
    expect(splashHtml).toContain("splashAPI.quit()");
  });

  it("splash preload exposes splashAPI via contextBridge", () => {
    expect(splashPreload).toContain("contextBridge.exposeInMainWorld");
    expect(splashPreload).toContain('"splashAPI"');
    expect(splashPreload).toContain('ipcRenderer.on("lifecycle"');
    expect(splashPreload).toContain('ipcRenderer.send("splash-quit")');
  });
});
