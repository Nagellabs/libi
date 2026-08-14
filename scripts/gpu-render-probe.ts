// scripts/gpu-render-probe.ts
//
// Empirical ground-truth probe for headless GPU rendering. For EACH candidate
// launch-flag set it launches a full Chromium (channel: "chromium" — never
// chrome-headless-shell, which lacks WebCodecs; see scripts/webcodecs-probe.ts
// and docs-local/webcodecs-matrix.md) and reports, from a secure-context file:// page:
//
//   1. UNMASKED_RENDERER_WEBGL  — the string that tells us software vs real GPU.
//   2. VideoEncoder.isConfigSupported({ ..., hardwareAcceleration: "prefer-hardware" })
//      — hardware H.264 encode availability (logged; NOT a gate in the driver).
//   3. A micro-benchmark: render 120 frames of a rotating textured WebGL quad at
//      1920×1080 and encode them via VideoEncoder; print effective fps.
//
// Run: npx tsx scripts/gpu-render-probe.ts
//
// If NO candidate yields a non-SwiftShader renderer on this machine, the GPU
// mode would never activate — STOP and report BLOCKED (see the render-accel plan).
import { chromium } from "playwright-core";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FlagSet = { label: string; args: string[] };

const FLAG_SETS: FlagSet[] = [
  {
    label: "gpu-metal",
    args: [
      "--enable-gpu",
      "--use-angle=metal",
      "--ignore-gpu-blocklist",
      "--enable-features=OpenH264SoftwareEncoder",
    ],
  },
  {
    label: "gpu-default-angle",
    args: [
      "--enable-gpu",
      "--ignore-gpu-blocklist",
      "--enable-features=OpenH264SoftwareEncoder",
    ],
  },
  {
    label: "software",
    args: ["--enable-features=OpenH264SoftwareEncoder", "--use-gl=swiftshader"],
  },
];

// The in-page probe. Reports the unmasked WebGL renderer, hardware-encode
// support, and a 120-frame render+encode micro-benchmark → fps. Sets
// document.title to "DONE:" + JSON, or "ERR:" + message.
const HTML = `<!doctype html>
<html><body>
<canvas id="c" width="1920" height="1080"></canvas>
<script>
(async () => {
  const out = { renderer: null, vendor: null, hwEncodeSupported: false, benchmark: null };
  try {
    const canvas = document.getElementById("c");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (!gl) throw new Error("no WebGL context");
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    out.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);

    // Hardware encode availability (prefer-hardware).
    if (typeof VideoEncoder !== "undefined") {
      try {
        const r = await VideoEncoder.isConfigSupported({
          codec: "avc1.640028", width: 1920, height: 1080,
          bitrate: 8_000_000, framerate: 30,
          hardwareAcceleration: "prefer-hardware",
        });
        out.hwEncodeSupported = r.supported === true &&
          (r.config?.hardwareAcceleration === "prefer-hardware" || r.config?.hardwareAcceleration === undefined);
      } catch (e) { out.hwEncodeError = String(e); }
    }

    // --- Micro-benchmark: rotating textured quad, 120 frames, render+encode ---
    // Minimal shader program.
    function compile(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, [
      "attribute vec2 aPos; attribute vec2 aUV; varying vec2 vUV;",
      "uniform float uAngle;",
      "void main(){ float c=cos(uAngle), s=sin(uAngle);",
      "  mat2 rot=mat2(c,-s,s,c); vec2 p=rot*aPos; vUV=aUV;",
      "  gl_Position=vec4(p,0.0,1.0); }",
    ].join("\\n"));
    const fs = compile(gl.FRAGMENT_SHADER, [
      "precision mediump float; varying vec2 vUV; uniform sampler2D uTex;",
      "void main(){ gl_FragColor=texture2D(uTex,vUV); }",
    ].join("\\n"));
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
    gl.useProgram(prog);

    const quad = new Float32Array([
      -0.8,-0.8, 0,0,  0.8,-0.8, 1,0,  -0.8,0.8, 0,1,
       0.8,-0.8, 1,0,  0.8,0.8, 1,1,   -0.8,0.8, 0,1,
    ]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    const aUV = gl.getAttribLocation(prog, "aUV");
    gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8);

    // Procedural 256x256 checker texture.
    const TS = 256; const pix = new Uint8Array(TS*TS*4);
    for (let y=0;y<TS;y++) for (let x=0;x<TS;x++){ const i=(y*TS+x)*4; const c=((x>>5)^(y>>5))&1?230:40;
      pix[i]=c; pix[i+1]=(x*255/TS)|0; pix[i+2]=(y*255/TS)|0; pix[i+3]=255; }
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,TS,TS,0,gl.RGBA,gl.UNSIGNED_BYTE,pix);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const uAngle = gl.getUniformLocation(prog, "uAngle");
    gl.viewport(0,0,1920,1080);

    const FRAMES = 120;
    let encoder = null, encoded = 0, encErr = null;
    const canEncode = typeof VideoEncoder !== "undefined";
    if (canEncode) {
      try {
        encoder = new VideoEncoder({
          output: () => { encoded++; },
          error: (e) => { encErr = String(e); },
        });
        encoder.configure({
          codec: "avc1.640028", width: 1920, height: 1080,
          bitrate: 8_000_000, framerate: 30,
          hardwareAcceleration: "prefer-hardware",
        });
      } catch (e) { encErr = String(e); encoder = null; }
    }

    const frameDurUs = Math.round(1e6/30);
    const t0 = performance.now();
    for (let f=0; f<FRAMES; f++) {
      gl.clearColor(0.05,0.05,0.08,1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uAngle, f*0.05);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (encoder) {
        const vf = new VideoFrame(canvas, { timestamp: f*frameDurUs });
        encoder.encode(vf, { keyFrame: f % 30 === 0 });
        vf.close();
      } else {
        gl.finish();
      }
    }
    if (encoder) { await encoder.flush(); encoder.close(); }
    else { gl.finish(); }
    const elapsedMs = performance.now() - t0;
    out.benchmark = {
      frames: FRAMES,
      elapsedMs: Math.round(elapsedMs),
      fps: +(FRAMES / (elapsedMs/1000)).toFixed(1),
      encoded,
      encoderUsed: !!encoder,
      encoderError: encErr,
    };
    document.title = "DONE:" + JSON.stringify(out);
  } catch (e) {
    document.title = "ERR:" + (e && e.message ? e.message : String(e));
  }
})();
</script></body></html>`;

async function probeFlagSet(flags: FlagSet, htmlPath: string) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: "chromium",
      args: flags.args,
    });
  } catch (err) {
    return { label: flags.label, args: flags.args, error: `launch failed: ${String(err)}` };
  }
  try {
    const page = await browser.newPage();
    await page.goto("file://" + htmlPath);
    await page.waitForFunction(
      () => document.title.startsWith("DONE:") || document.title.startsWith("ERR:"),
      null,
      { timeout: 60_000 },
    );
    const title = await page.title();
    if (title.startsWith("ERR:")) {
      return { label: flags.label, args: flags.args, error: title.replace(/^ERR:/, "") };
    }
    const parsed = JSON.parse(title.replace(/^DONE:/, ""));
    return { label: flags.label, args: flags.args, ...parsed };
  } catch (err) {
    return { label: flags.label, args: flags.args, error: String(err) };
  } finally {
    await browser.close().catch(() => {});
  }
}

function isSoftware(renderer: unknown): boolean {
  return typeof renderer === "string" && /swiftshader|software|llvmpipe/i.test(renderer);
}

async function main() {
  const htmlPath = join(tmpdir(), `gpu-render-probe-${Date.now()}.html`);
  writeFileSync(htmlPath, HTML, "utf8");
  const results = [];
  try {
    for (const flags of FLAG_SETS) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probeFlagSet(flags, htmlPath);
      results.push(r);
    }
  } finally {
    try { unlinkSync(htmlPath); } catch {}
  }

  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 2));

  // Human-readable table.
  console.log("\n=== Headless GPU probe ===");
  console.log("label              | renderer                                              | hwEncode | fps");
  console.log("-------------------|-------------------------------------------------------|----------|------");
  for (const r of results as Array<Record<string, unknown>>) {
    const label = String(r.label).padEnd(18);
    const rend = r.error ? `ERROR: ${r.error}` : String(r.renderer ?? "?");
    const soft = r.error ? "" : isSoftware(r.renderer) ? " [software]" : " [GPU]";
    const hw = r.error ? "-" : (r.hwEncodeSupported ? "yes" : "no");
    const bench = (r.benchmark as { fps?: number } | undefined);
    const fps = r.error ? "-" : String(bench?.fps ?? "?");
    console.log(`${label} | ${(rend + soft).slice(0, 53).padEnd(53)} | ${String(hw).padEnd(8)} | ${fps}`);
  }

  const anyGpu = (results as Array<Record<string, unknown>>).some(
    (r) => !r.error && r.renderer && !isSoftware(r.renderer),
  );
  console.log(`\nverdict: ${anyGpu ? "GPU available in at least one flag set" : "BLOCKED — no non-SwiftShader renderer on this machine"}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
