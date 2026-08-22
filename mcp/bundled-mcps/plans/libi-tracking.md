# Install guide: Object Tracking engine (`libi-tracking`)

The libi-tracking engine is a local Python sidecar (boxmot + ONNX models,
~2 GB, ~10–20 min cold install). It is **NOT** installed at boot — install it
on demand the first time a tracking tool reports `tracking_engine_not_installed`.

## When you need this guide

A tracking tool (e.g. `libi.compute_object_track`) returned:
```json
{ "error": "tracking_engine_not_installed",
  "data": { "installPlanPath": "mcp/bundled-mcps/plans/libi-tracking.md" } }
```

Call `libi.get_install_plan({ mcpId: "libi-tracking" })` to get this guide at
runtime, then follow the steps below. The whole loop is:
error → this plan → `libi.install_tracking_engine` → `libi.verify_install` →
retry the original tool call.

## Where things go — resolve `<LIBI_HOME>` FIRST, never assume `~/.libi`

Every path below is written as `<LIBI_HOME>/…`. **Resolve it before you run
anything:** it is the `LIBI_HOME` environment variable when set, and only
`~/.libi` when it is not. The two differ constantly in practice —

| How libi is running | `<LIBI_HOME>` |
|---|---|
| `npx @nagellabs/libi` (default) | `~/.libi` |
| the packaged desktop app | `~/Library/Application Support/libi` (macOS) |
| a dev worktree | `~/.libi/worktrees/<name>` |

Getting this wrong is not a cosmetic slip. Models written to the wrong home
are invisible to the engine that needs them — `verify_install` keeps reporting
them missing no matter how many times you download them — and they are written
into *somebody else's* libi installation, which may hold real user work. If you
cannot read the env var directly, `libi.verify_install({})` reports the paths
the engine actually looks at; trust that over any path in this document.

## Install steps

1. **Check current status** — call `libi.verify_install({})`. If the result
   shows `installed: true` and `ok: true`, you're done — the loop is already
   closed; retry the original tool call. Otherwise continue.

2. **Disclose the cost and get the user's approval.** Before starting, tell
   the user (paraphrase, don't paste verbatim):

   > "The local tracking engine isn't installed yet. Installing it takes
   > **~10–20 minutes** on a cold machine and downloads **~2 GB** to your
   > machine (Python env + tracking models, incl. a one-time 572 MB
   > export-input download that stays cached). Free, on-device, no API key.
   > OK to start?"

   Wait for explicit approval. Do not start the install on an inferred yes.

3. **Run the installer** — call `libi.install_tracking_engine({})`. This is
   the ONE tool that actually installs the engine: it enqueues the
   `tracking_engine_install` job, streams progress to you, and returns the
   final status. Do NOT run `uv` or download models by hand — the job does
   all of it:
   - Runs `uv sync` inside `mcp/tracking/py/` to create a local venv with
     boxmot and all Python deps.
   - Provisions the ONNX tracking models into `<LIBI_HOME>/models/tracking/`.
   - Provisions the generalized YOLOE-VP detector (`ultralytics` +
     `yoloe-11s-seg.pt`, ~28 MB) so tracking arbitrary non-person objects
     works automatically (no separate install).
   - Provisions `matanyone/config.json` + `matanyone/model.safetensors` —
     MatAnyone mask-guided video-matting weights (powers
     `libi.remove_background`'s free local engine).
   - Exports `yoloe11.onnx` locally from those pinned inputs (see step 4) —
     fully unattended.

   Pass `force: true` only to reinstall over a broken or stale install; omit
   it otherwise. Note that `libi.get_install_plan` and
   `libi.update_dep_status` install nothing — the first only returns this
   document, the second only records a status row (see step 6).

4. **YOLOE model note** — `yoloe11.onnx` is built automatically by the
   installer on this machine (build-at-install): it exports the ONNX from the
   sha-pinned `yoloe-11s-seg.pt` checkpoint using a sha-pinned 572 MB
   text-encoder download (cached at `<LIBI_HOME>/models/tracking/.build/`,
   fetched once) and a pinned CLIP commit archive. No manual step is needed —
   if the export fails, the installer error names the exact input or command
   that failed; fix that and re-run step 3 (the flow is idempotent, and
   already-current artifacts are skipped via `yoloe11.onnx.build-info.json`).
   It is deliberately NEVER hosted by libi: all export inputs are AGPL-3.0
   (ultralytics + YOLOE weights + the CLIP fork), so building locally avoids
   libi redistributing an AGPL-derived binary.

5. **Verify the install** — call `libi.verify_install({})`. Expect
   `ok: true` with a `versions` map listing the Python env and model files.
   A successful `verify_install` ALSO closes the lazy-install loop: it runs
   the engine self-test and persists `tracking-pyenv` as installed in the
   dependency registry the tracking gate reads, so the next tracking call is
   unblocked. You do NOT need to hand-patch the database.

6. **Retry** — re-run the original tracking tool call; it now succeeds.
   (Optional, for the Settings UI badge only: `libi.update_dep_status({
   mcpId: "libi-tracking", status: "installed" })`. `update_dep_status`
   records install status in the registry the Settings page reads — that is
   all it does. It never installs anything and is NOT required to unblock
   tracking; `verify_install` already did that. It takes `mcpId` + `status` —
   there is no `depId` or `id` parameter.)

## If the install fails

- `libi.install_tracking_engine` returns the failing step and error; fix the
  named input and call it again — the job resumes idempotently.
- Run `libi.diagnose_mcp({ mcpId: "libi-tracking" })` — the `auxiliary` field
  shows the last error from the Python sidecar probe.
- `uv` errors: ensure `<LIBI_HOME>/bin/uv` exists (libi installs it in Category A).
  If missing, re-run `node bin/libi.js` to trigger the boot installer.
- ONNX model errors: see step 4 above (YOLOE acquisition).
- After fixing: re-run step 3, then step 5 to confirm.
