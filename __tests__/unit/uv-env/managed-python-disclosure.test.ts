/**
 * Every on-device Python feature now downloads libi's own CPython the first
 * time (UV_PYTHON_PREFERENCE=only-managed), so each one's install disclosure
 * must count it — the install plans the agent reads, and the provider
 * catalog's size notes the user sees. Pinned to the measured constants so the
 * figures cannot drift apart.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MANAGED_PYTHON_DISK_MB, MANAGED_PYTHON_DOWNLOAD_MB } from "@/lib/uv-env/managed-python-size";
import { PROVIDER_CATALOG } from "@/lib/providers/catalog";

describe("the managed CPython is in every Python feature's disclosure", () => {
  it.each(["whisper", "local-tts", "local-music", "libi-tracking"])("install plan: %s", (id) => {
    const plan = fs.readFileSync(path.join(process.cwd(), "mcp/bundled-mcps/plans", `${id}.md`), "utf-8");
    expect(plan).toContain(`~${MANAGED_PYTHON_DOWNLOAD_MB} MB`);
    expect(plan).toContain(`~${MANAGED_PYTHON_DISK_MB} MB`);
    expect(plan).toMatch(/libi's own CPython 3\.1[12]/);
  });

  it.each(["whisper", "kokoro", "ace-step"])("provider size note: %s", (id) => {
    const entry = PROVIDER_CATALOG.find((p) => p.id === id)!;
    expect(entry.sizeNote).toContain(`~${MANAGED_PYTHON_DISK_MB} MB for libi's own Python`);
  });
});
