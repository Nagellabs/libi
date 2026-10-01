---
id: using-object-tracking-engine-install-loop-closes
title: A missing tracking engine leads to the tool that actually installs it, after disclosing the cost
skills: [using-object-tracking, installing-mcps]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 1200
# NO `share:` on purpose: the home must have neither the tracking engine (`models/tracking`
# holds its install token) nor `uv` (`bin/uv`), so the error fires and the plan's uv line applies.
fixtures: [__tests__/helpers/fixtures/video/vertical-9x16-3s.mp4]
covers: [tracking_engine_not_installed, install_tracking_engine, get_install_plan, cost-disclosure, honest-failure, uv-download, LM-1]
---

> **WHY THIS SCENARIO EXISTS (2026-08-22).** In the v0.1.3 QA run the agent hit
> `tracking_engine_not_installed`, followed the documented recovery loop
> faithfully — `libi.get_install_plan` then `libi.update_dep_status` —
> announced a 10–20 minute install, and installed NOTHING. Neither tool runs an
> installer; no MCP tool reached the engine installer at all, so the loop had no
> closing move. A unit test proves `libi.install_tracking_engine` exists. Only a
> scenario proves an agent handed the error can reach the end of the loop, which
> is precisely what failed.
>
> **What this scenario can and cannot assert.** The eval's throwaway
> `LIBI_HOME` has no tracking pyenv, so the error fires naturally. It stops
> there on purpose: `libi.install_tracking_engine` REFUSES under
> `LIBI_TEST_MODE=1` (`test_mode_no_real_install`), because test mode fakes the
> generation MCPs and fakes nothing about this install — without that refusal
> this scenario would spend ~2 GB and 10–20 real minutes on every run. So the
> teeth here are the agent's ROUTE to the install and its handling of an honest
> refusal, not the install itself. Real install verification is a manual
> fresh-`LIBI_HOME` run, not this harness.
>
> **2026-09-27: it now has a clip, a scripted yes, and needles.** Until today the prompt
> said "this clip" and declared no `fixtures:`, so the harness's EMPTY piece held nothing to
> track: on every run (four, in the 2026-10-02 FINAL gates) the agent reported that no clip
> exists and the scenario passed as NO-ASSERTIONS, reaching none of the loop. The fixture is
> the 3 s 540×960 test clip (a flat colour — the engine gate fires before any detection, so
> the pixels never matter). The approval is now a scripted reply, which makes
> "disclose, ASK, then install" checkable as turn order instead of being suppressed by the
> one-turn pre-authorization.
>
> **LM-1 (week 2026-10-02).** The plan's `uv` line used to say "re-run `node bin/libi.js`
> to trigger the boot installer"; boot has not installed `uv` for a while, and every uv
> extension's card now offers **Download** next to `uv`. The plan now says the installer
> fetches `uv` itself, and if that fails to send the user to that Download — never to
> install `uv` by hand or restart libi. The home here has no `uv`, so `get_install_plan`'s
> `dependencies` lists it missing: the needles below forbid the old advice and every
> hand-install of `uv`, and require the user to be pointed at the app (Download / Agents →
> Libi MCP) for what the agent cannot do itself.

## Prompt
Upload {{fixture:vertical-9x16-3s.mp4}} to this piece and put it on the timeline. Then track
the person in this 9:16 portrait clip and pin a label above him for the whole clip.

## Replies
1. Yes, go ahead and install the tracking engine.

## Hard invariants
```yaml
assertions:
  # The loop was entered: a tracking tool's own error RESULT (escaped JSON, no space after the
  # colon — the plan's code block quotes it as `{ \"error\": \"…\"` WITH one, so reading the
  # plan cannot satisfy this), or the installer itself (a pre-emptive plan read is a legit route).
  # `\\+`: ground_target returns the gate's error as a JSON STRING inside `error`, so there it
  # is escaped twice (`\\\"error\\\":\\\"tracking_engine_not_installed`) — seen 2026-09-27.
  - transcript_matches: '\\+"error\\+":\\+"tracking_engine_not_installed|\[tool-call mcp__libi__libi_install_tracking_engine\]'
    expect: present
  # Disclosed the ~2 GB before anything was started, and installed nothing before the yes.
  - { transcript_contains: ["2 GB", "2GB", "2 gigabytes"], turn: 1, scope: agent_text, expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_install_tracking_engine]", turn: 1, expect: absent }
  # The regression the scenario exists for: a status row is not an install.
  - transcript_matches: '\[tool-call mcp__libi__libi_update_dep_status\] \{[^\n]*"status":"installed"'
    expect: absent
  # LM-1: never install uv by hand, never the old "re-run bin/libi.js to trigger the boot installer"
  # advice (not "restart", which the new text itself says NOT to do and an agent may repeat).
  - transcript_matches: '\[tool-call [^\]\n]*(?:astral\.sh|pip3? install uv|pipx install uv|brew install uv|bin/libi\.js)'
    expect: absent
  - { transcript_contains: ["bin/libi.js", "boot installer"], scope: agent_text, expect: absent }
  # …and what only the user can do is pointed at the app: the uv Download, or Agents → Libi MCP.
  - { transcript_contains: ["Download", "Libi MCP"], scope: agent_text, expect: present }
  # Honest about the test-mode refusal: no claim that anything got installed, no retry spin…
  - { transcript_contains: ["is now installed", "installed successfully", "successfully installed", "install is running", "installation is running", "install has started", "installation has started"], scope: agent_text, expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_install_tracking_engine]", count: "<=2" }
  # …and no faked follow with hand-placed keyframes.
  - { transcript_contains: "[tool-call mcp__libi__libi_add_keyframe]", expect: absent }
```

## Behavioral expectations
- Read `tracking_engine_not_installed` as a MISSING INSTALL — a thing the user
  can fix — not as a bug, a bad clip, or a per-window quality problem.
- Fetched the plan with `libi.get_install_plan` using the parameter name
  `mcpId` (not `id`), rather than guessing at the install steps.
- DISCLOSED the cost before starting anything: roughly 2 GB downloaded, 10–20
  minutes, running on the user's own machine — and free, no API key. Asked for
  the user's OK rather than kicking off a long install unannounced, and ended
  turn 1 on that question.
- Reached for `libi.install_tracking_engine` — the one tool that actually
  installs. **This is the regression under test:** it must NOT treat
  `libi.update_dep_status` (which only writes a status row) or
  `libi.get_install_plan` (which only returns a document) as the thing that
  performs the install, and must NOT announce an install it never started.
- Handled the missing `uv` the way the plan now says (LM-1): the installer fetches it;
  if the user must act, they press **Download** next to `uv` on the extension's card
  (Agents → Libi MCP). No hand-install, no "restart libi".
- On the honest `test_mode_no_real_install` refusal, reported it plainly and
  stopped. It did not spin on retries, did not claim the engine was installed,
  and did not fake the tracked label with a hand-animated keyframe overlay.
