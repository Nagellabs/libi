import ora, { type Ora } from "ora";
import type { LifecycleAdapter, LifecycleEvent } from "../types";

export function cliAdapter(): LifecycleAdapter {
  const spinners = new Map<string, Ora>();

  function fmtBytes(b: number): string {
    if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    if (b > 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  }

  return {
    onEvent(e: LifecycleEvent) {
      switch (e.kind) {
        case "prelude-start":
          process.stdout.write("\n[libi] Setting up…\n\n");
          break;

        case "category-a-install-start": {
          // Default text is "Verifying" — accurate on the hot path where
          // nothing actually downloads. Switches to "Downloading" when
          // an install-progress event arrives with bytes.
          const sp = ora(`Verifying ${e.item.label}`).start();
          spinners.set(`install:${e.item.id}`, sp);
          break;
        }

        case "category-a-install-progress": {
          const key = `install:${e.item.id}`;
          let sp = spinners.get(key);
          if (!sp) {
            sp = ora(`Downloading ${e.item.label}`).start();
            spinners.set(key, sp);
          }
          // `detail` wins when set: it carries progress for installs libi
          // can't count bytes for (npm), where the byte fields are 0/null and
          // would render a permanent "(0 B)".
          if (e.detail) {
            sp.text = `Downloading ${e.item.label} (${e.detail})`;
          } else {
            const total = e.bytesTotal ? ` / ${fmtBytes(e.bytesTotal)}` : "";
            sp.text = `Downloading ${e.item.label} (${fmtBytes(e.bytesDownloaded)}${total})`;
          }
          break;
        }

        case "category-a-install-done": {
          const sp = spinners.get(`install:${e.item.id}`);
          if (e.result === "skipped") sp?.info(`${e.item.label}: ${e.reason ?? "skipped"}`);
          else if (e.result === "failed") sp?.warn(`${e.item.label}: ${e.reason ?? "install failed"}`);
          else sp?.succeed(`${e.item.label}`);
          spinners.delete(`install:${e.item.id}`);
          break;
        }

        case "category-a-probe-start": {
          const sp = ora(`Verifying ${e.label}`).start();
          spinners.set(`probe:${e.mcpId}`, sp);
          break;
        }

        case "category-a-probe-done": {
          const sp = spinners.get(`probe:${e.mcpId}`);
          if (e.status === "up") sp?.succeed(`${e.label} verified (${e.durationMs}ms)`);
          else if (e.status === "skipped") sp?.info(`${e.label}: ${e.reason ?? "skipped"}`);
          else sp?.fail(`${e.label}: probe failed`);
          spinners.delete(`probe:${e.mcpId}`);
          break;
        }

        case "category-a-done":
          process.stdout.write(`\n[libi] Setup complete (${e.durationMs}ms)\n`);
          break;

        case "category-b-step":
          // Category B runs in the Next.js process; the CLI parent doesn't
          // render its steps. They'll appear in the splash / browser UI.
          break;

        case "category-b-done":
          // Same as above — CLI doesn't render Category B's completion.
          break;

        case "fatal":
          // Stop any active spinners with a fail mark.
          for (const sp of spinners.values()) sp.fail();
          spinners.clear();
          process.stderr.write(
            [
              "",
              `✗ ${e.phase}${e.step ? ` / ${e.step}` : ""} failed`,
              "",
              `  ${e.error}`,
              "",
              `  ${e.hint.split("\n").join("\n  ")}`,
              "",
            ].join("\n") + "\n",
          );
          break;

        case "server-listening":
          process.stdout.write(`[libi] Server listening on ${e.url}\n`);
          break;
      }
    },
  };
}
