import { join } from "node:path";
import { existsSync } from "node:fs";
import { getLibiBinDir, getLibiHome } from "@/lib/libi-home";
import { exeSuffix } from "@/lib/platform";

export function uvPath(): string {
  const p = join(getLibiBinDir(), `uv${exeSuffix()}`);
  return existsSync(p) ? p : "uv";
}

export function sidecarProjectDir(): string {
  return join(process.cwd(), "mcp", "tracking", "py");
}

export function trackingModelsDir(): string {
  return join(getLibiHome(), "models", "tracking");
}
