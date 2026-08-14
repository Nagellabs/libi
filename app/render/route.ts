/**
 * Static HTML page for the off-browser canvas export.
 *
 * Runs inside a hidden Playwright/Electron window. Intentionally NOT a
 * Next.js App Router page — in Next 16 dev mode (turbopack), client
 * hydration never completes reliably in headless Chromium automation,
 * so useEffect never fires. Serving a minimal standalone HTML shell +
 * an esbuild-bundled render entry (via /api/export/render-bundle)
 * sidesteps Next's client runtime entirely and works in both dev and
 * production.
 *
 * The page reads `jobId` + `token` from its query string, registers
 * `window.__libiRender.runRender`, then invokes it.
 */

function escapeForJs(s: string): string {
  // The value ends up inside a double-quoted JS string literal in HTML, so
  // we need to escape backslashes, both quote styles, and anything that could
  // terminate the <script> block.
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
    <title>Libi Render</title>
    <style>
      html, body { margin: 0; padding: 0; background: #111; color: #fff; font-family: system-ui, sans-serif; }
      #status { padding: 16px; }
    </style>
  </head>
  <body>
    <div id="status">loading</div>
    <script src="/api/export/render-bundle"></script>
    <script>
      (function () {
        function boot() {
          var api = window.__libiRender;
          if (!api || typeof api.runRender !== "function") {
            setTimeout(boot, 50);
            return;
          }
          api.runRender({ jobId: "${jobIdSafe}", token: "${tokenSafe}" });
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
