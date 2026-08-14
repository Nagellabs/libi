/**
 * Static HTML page for off-browser face/object tracking.
 *
 * Mirrors `/render` exactly — minimal HTML shell loaded by Playwright
 * Chromium, with an esbuild-bundled entry served from `/api/track-bundle`.
 * Reads jobId + token from the query string and hands them to
 * `window.__libiTrack.runTrack`.
 */

function escapeForJs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/</g, "\\u003c");
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const token = url.searchParams.get("token") ?? "";
  if (!jobId || !token) {
    return new Response(
      `<!doctype html><html><body style="color:white;background:#111;padding:16px">Missing jobId/token</body></html>`,
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  const jobIdSafe = escapeForJs(jobId);
  const tokenSafe = escapeForJs(token);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Libi Track</title>
    <style>
      html, body { margin: 0; padding: 0; background: #111; color: #fff; font-family: system-ui, sans-serif; }
      #status { padding: 16px; }
    </style>
  </head>
  <body>
    <div id="status">loading</div>
    <video id="video" style="display:none" playsinline muted></video>
    <script src="/api/track-bundle"></script>
    <script>
      (function () {
        function boot() {
          var api = window.__libiTrack;
          if (!api || typeof api.runTrack !== "function") {
            setTimeout(boot, 50);
            return;
          }
          api.runTrack({ jobId: "${jobIdSafe}", token: "${tokenSafe}" });
        }
        boot();
      })();
    </script>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
