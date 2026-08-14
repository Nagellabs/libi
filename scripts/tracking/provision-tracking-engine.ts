/**
 * Manual/dev entrypoint: provision the tracking engine end to end via the
 * exact code path the tracking-pyenv custom installer runs in production
 * (`uv sync --locked` + sha-pinned model downloads + the local yoloe11 ONNX
 * export). Useful for verifying a clean install without booting libi:
 *
 *   LIBI_HOME=/tmp/some-isolated-home npx tsx scripts/tracking/provision-tracking-engine.ts
 *
 * Requires `uv` resolvable (either `<LIBI_HOME>/bin/uv` or `uv` on PATH).
 * NEVER point LIBI_HOME at a home you care about unless you mean it — the
 * run writes the venv, model artifacts, and install token there.
 */
import { runTrackingPyenvInstall } from "@/mcp/registry/installers/tracking-pyenv";
import { getLibiHome } from "@/lib/libi-home";

async function main() {
  console.log(`provisioning tracking engine into LIBI_HOME=${getLibiHome()}`);
  const started = Date.now();
  await runTrackingPyenvInstall();
  console.log(
    `tracking engine provisioned in ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

main().catch((e) => {
  console.error("provision failed:", e);
  process.exit(1);
});
