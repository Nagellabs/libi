---
id: code-overlays-fix-from-diagnostic
title: Agent writes a broken draw body, reads renderDiagnostics, and fixes the file until it clears
skills: []
mcps: []
agent: claude-code
runs: 1
timeoutSec: 900
share: [bin]
covers: [code-overlays, render-diagnostics, get_piece_state, render_overlay_frames, edit-overlay-file, verify-loop]
---

> **What the invariants read.** Every `libi.*` call renders into the transcript as
> `[tool-call mcp__libi__libi_<tool>] {args}` and its result as `[tool-result  ok] [{"type":"text","text":"<JSON>"}]`
> (`scripts/skill-eval/harness.ts#renderPart`): the result's JSON is a string inside JSON, so
> its quotes appear escaped — `\"renderDiagnostics\":[{…}]`. A needle written with those
> backslashes can only match a tool RESULT, never the prompt or the agent's own prose, and
> only `libi.get_piece_state` returns a `renderDiagnostics` key (`render_overlay_frames`
> returns frames only, `mcp/tools/render-tools.ts`). A file edit renders as the file tool's
> raw input, `{"file_path":"…/draw.jsx","old_string":"…"}` for Edit and
> `{"file_path":"…","content":"…"}` for Write, and a shell write as `{"command":"cat > \"…/draw.jsx\" <<'EOF'…"}`.
> Run 1 (`skill-eval/runs/2026-09-23T15-10-55-528Z`) fixed the file with exactly that heredoc,
> and the first draft of these matchers knew only Edit/Write — so a shell command that
> redirects into, `tee`s, or `sed -i`s the file counts as editing it. Reading it (`cat path`)
> does not. The shell detector is deliberately rough: it misses `cp`, `mv`, `perl -pi` and
> `python -c` writes (a false FAIL, loud), and stops a `sed -i` at `;`, `&` or `|` so it cannot
> borrow a path from a later command.
>
> **An Edit/Write call can render with EMPTY args** — `[tool-call Preparing file…] {}`
> (`skill-eval/runs/2026-09-04T13-54-45-864Z/generate-at-piece-aspect/claude-code/run-1/transcript.md:133-145`).
> Its result still names the file, as a plain JSON string on its own line:
> `[tool-result  ok] "The file <path> has been updated successfully. …"` (Write of a new file:
> `"File created successfully at: <path>"`). That result counts as the edit. It follows the
> write, so the ordering claims hold, and it cannot be forged by a tool's printed output — that
> arrives inside a JSON string, its newline escaped as `\n` and its quote as `\"`. Every edit
> alternative — args, result, shell — is tied to the `codeFilePath` that `add_overlay` returned
> by a backreference, never to "some `draw.jsx`".
>
> **Why regexes, in this order.** Three of these claims are about ORDER or IDENTITY, which a
> substring count cannot carry:
>
> - A saved body clears its overlay's entry on its own (`mcp/templates/instructions.md`, "When
>   a code overlay breaks"), so an empty `renderDiagnostics` read straight after the edit
>   proves nothing about the fix. The "clean" invariant therefore needs the LAST edit, then a
>   `render_overlay_frames` that returned frames, then an empty read, with no non-empty read
>   after it. A fixed body that still throws re-records an entry on that render and fails it.
> - "At the failing time or frame" is a backreference: the `time` / `frame` of the render
>   entry the agent read, then an edit of `draw.jsx`, then a render whose `atTimes` holds that
>   exact time, or whose result drew that exact frame.
> - "Edited the codeFilePath" is the path `add_overlay` returned (a leading `/private` is
>   allowed either side — macOS temp paths have both spellings), edited after the agent read
>   the diagnostic.
>
> A unit test runs these exact matchers over synthetic transcripts in the real rendered
> format, and shows each one failing on the run it exists to catch
> (`__tests__/unit/skill-eval/scenario-code-overlays.test.ts`).
>
> **The brief's `endpoint_id: "*"` absent invariant is not here.** With `mcps: []` the harness
> detaches the fal / ElevenLabs fakes, so no call can ever be recorded and it would pass on
> every run. There is no generation tool in front of this agent to misuse.
>
> `share: [bin]` copies `~/.libi/bin` in: `render_overlay_frames` encodes through ffmpeg, and
> an empty hermetic home spent over 240 s trying to download Node before it would boot.

## Prompt
On a new 1920x1080 piece, add ONE full-frame code overlay named "diagnostic-probe" for the
first 3 seconds. For its body, use EXACTLY this text on purpose — it is deliberately broken
and this exercise is about how you recover from that:

```
const { ctx, width, height, progress } = context;
ctx.fillStyle = "#0f172a";
ctx.fillRect(0, 0, width, height);
drawPulsingCircle(ctx, width / 2, height / 2, 120 + progress * 80);
```

After adding it, verify the overlay renders (render frames), find out what is wrong from
libi itself rather than by guessing, fix the overlay's file so the circle draws (a plain
`drawCircle` with a fill is fine), and confirm the problem is gone. Do NOT generate any
video, image or audio — overlay work only.

## Hard invariants
```yaml
assertions:
  # 1. It read libi.get_piece_state and saw the render entry for this body: a code overlay,
  #    phase render, the undefined helper named, line 4 of the body, framed as untrusted.
  - transcript_matches: '\\"renderDiagnostics\\":\[\{(?=[^{}]*\\"overlayId\\":\\"code-)(?=[^{}]*\\"phase\\":\\"render\\")(?=[^{}]*drawPulsingCircle is not defined)(?=[^{}]*\\"line\\":4[,}])(?=[^{}]*\\"messageSource\\":\\"overlay body \(untrusted\)\\")'
    expect: present
  # 2. After reading that diagnostic, it edited the codeFilePath add_overlay returned —
  #    Edit/Write (by their args, or by their result when the args render empty) or a shell write.
  - transcript_matches: '\\"codeFilePath\\":\\"(?:/private)?([^"\\]+/draw\.jsx)\\"[\s\S]*?\\"renderDiagnostics\\":\[\{[\s\S]*?(?:"file_path":"(?:/private)?\1","(?:old_string|content)":"|"command":"[^\n]*?(?:>|\btee\s+(?:-a\s+)?|\bsed\s+-i[^\n;&|]*?)\s*(?:\\"|'')?(?:/private)?\1|\n\[tool-result  ok\] "(?:The file (?:/private)?\1 has been updated|File created successfully at: (?:/private)?\1(?![\w.-])))'
    expect: present
  # 3. Not by a string update or a re-add: no update_overlay carrying code, no add_overlay
  #    whose body lacks the broken helper, no removal. The server refuses code on
  #    update_overlay (its MCP schema is strict), so the first needle counts ATTEMPTS: a
  #    tripwire on intent, since such a call can change nothing.
  - transcript_matches: '\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"(?:body|drawFunction|sceneFunction|code|source)":'
    expect: absent
  - transcript_matches: '\[tool-call mcp__libi__libi_add_overlay\] \{[^\n]*"body":"(?:(?!drawPulsingCircle)[^"\\]|\\.)*"'
    expect: absent
  - transcript_contains:
      - "[tool-call mcp__libi__libi_remove_overlay]"
      - "[tool-call mcp__libi__libi_delete_clip]"
    expect: absent
  - transcript_matches: '\[tool-call mcp__libi__libi_add_overlay\] [^\n]*\n+\[tool-result  ok\] [^\n]*?\\"success\\":true'
    count: "==1"
  # 4. It re-rendered the failing time (or the failing frame) AFTER editing the file. (The
  #    frame branch is weak here: the only render before the diagnostic is the default
  #    sample, so any default re-render draws the failing frame. It still needs a post-edit
  #    render; #5 carries the stronger claim.)
  - transcript_matches: '\\"codeFilePath\\":\\"(?:/private)?([^"\\]+/draw\.jsx)\\"[\s\S]*?\\"renderDiagnostics\\":\[\{(?=[^{}]*\\"phase\\":\\"render\\")(?=[^{}]*\\"time\\":(\d+(?:\.\d+)?)[,}])(?=[^{}]*\\"frame\\":(\d+)[,}])[\s\S]*?(?:"file_path":"(?:/private)?\1","(?:old_string|content)":"|"command":"[^\n]*?(?:>|\btee\s+(?:-a\s+)?|\bsed\s+-i[^\n;&|]*?)\s*(?:\\"|'')?(?:/private)?\1|\n\[tool-result  ok\] "(?:The file (?:/private)?\1 has been updated|File created successfully at: (?:/private)?\1(?![\w.-])))[\s\S]*?\[tool-call mcp__libi__libi_render_overlay_frames\] \{[^\n]*?(?:"atTimes":\[[^\]]*?(?<![\d.])\2(?![\d.])|\n+\[tool-result  ok\] [^\n]*?\\"frame\\":\3[,}])'
    expect: present
  # 5. Its final read is clean: after its LAST edit of the file, a render that returned
  #    frames, then an empty renderDiagnostics, and no non-empty read after that. A body
  #    still failing on a frame that render drew is re-recorded before the render returns
  #    (__tests__/unit/export/render-result-diagnostics.test.ts), so this fails a fix that
  #    still throws THERE; it says nothing about frames the render did not draw.
  - transcript_matches: '\\"codeFilePath\\":\\"(?:/private)?([^"\\]+/draw\.jsx)\\"[\s\S]*?(?:"file_path":"(?:/private)?\1","(?:old_string|content)":"|"command":"[^\n]*?(?:>|\btee\s+(?:-a\s+)?|\bsed\s+-i[^\n;&|]*?)\s*(?:\\"|'')?(?:/private)?\1|\n\[tool-result  ok\] "(?:The file (?:/private)?\1 has been updated|File created successfully at: (?:/private)?\1(?![\w.-])))(?![\s\S]*(?:"file_path":"(?:/private)?\1","(?:old_string|content)":"|"command":"[^\n]*?(?:>|\btee\s+(?:-a\s+)?|\bsed\s+-i[^\n;&|]*?)\s*(?:\\"|'')?(?:/private)?\1|\n\[tool-result  ok\] "(?:The file (?:/private)?\1 has been updated|File created successfully at: (?:/private)?\1(?![\w.-]))))[\s\S]*?\[tool-call mcp__libi__libi_render_overlay_frames\] [^\n]*\n+\[tool-result  ok\] [^\n]*?\\"frames\\":\[\{[\s\S]*?\\"renderDiagnostics\\":\[\](?![\s\S]*\\"renderDiagnostics\\":\[\{)'
    expect: present
```

## Behavioral expectations
- Added the overlay with `libi.add_overlay({ kind: "code", displayName: "diagnostic-probe", body: … })` and kept the returned `codeFilePath`.
- Called `libi.render_overlay_frames({ pieceId, overlayId })` (there is no editor open in this run, so the diagnostics fill from the render path) and THEN `libi.get_piece_state({ pieceId })`, and read `renderDiagnostics` — an entry for this overlay with `phase: "render"`, a message naming `drawPulsingCircle is not defined`, a `line` (4), the failing `time` and `frame`, and the absolute `file`.
- Fixed the body by EDITING that file — Edit/Write or a shell write both count (replacing the undefined helper with `drawCircle` or an explicit `ctx.arc` + `ctx.fill`) — NOT by re-adding the overlay and NOT via `update_overlay` (there is no code-string update tool).
- Re-ran `libi.render_overlay_frames` at the reported `time` (checking the returned `frame` matches), Read the PNG to see the circle, and called `libi.get_piece_state` again: `renderDiagnostics` no longer lists the overlay.
- Told the user what was wrong (an undefined helper, at line 4), how it learned that (`renderDiagnostics`), and what it changed — in a few lines, not a lecture.
- Generated nothing (no fal/image/video/audio calls).
