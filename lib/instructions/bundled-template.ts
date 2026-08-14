import fs from "node:fs";
import path from "node:path";

function candidates(): string[] {
  return [
    path.join(process.cwd(), "mcp", "templates", "instructions.md"),
    // lib/instructions/ → repo root → mcp/templates (compiled or in-tree)
    path.resolve(__dirname, "..", "..", "mcp", "templates", "instructions.md"),
    path.resolve(__dirname, "..", "..", "..", "mcp", "templates", "instructions.md"),
  ];
}

/** Read the bundled instructions template. Throws when not found. */
export function loadBundledTemplate(): string {
  for (const filePath of candidates()) {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf-8");
  }
  throw new Error(`instructions.md template not found (tried: ${candidates().join(", ")})`);
}
