---
id: meta-host-config-isolation
title: The inner agent does not see the host user's own Claude config (~/.claude/CLAUDE.md)
skills: []
mcps: []
agent: claude-code
runs: 1
timeoutSec: 240
covers: [harness, hermeticity, host-config, setting-sources]
---

> **What this catches.** skill-eval runs the inner agent on the host's own Claude Code
> CLI. claude-agent-acp's default `settingSources` is `["user", "project", "local"]`, so
> unless the harness says otherwise the HOST user's `~/.claude/CLAUDE.md`, user settings
> (hooks, plugins) and `~/.claude/skills` load into every eval session. That once made
> `templates/04` and `/05` pass for the wrong reason: a host rule ("publish only on
> weekends") held the publish back, not libi's own surfaces. The harness now sets
> `LIBI_AGENT_SKIP_USER_SETTINGS=1`, which drops the `user` source in test mode
> (`lib/sessions/session-meta.ts`); auth is not a setting source and is untouched.
>
> **Only meaningful on a host that HAS a `~/.claude/CLAUDE.md`.** Without one it passes
> trivially. The agent is told not to open any file, so the check is what its context
> already holds — it never reads the host file into a transcript.

## Prompt
This is a configuration check, not a video task. Do not call any tool, run any command
or read any file — answer only from what is already in your context. Are there any
user-level (global) CLAUDE.md memory instructions in your context — instructions that
come from the user's own home Claude configuration rather than from libi or this
workspace? Reply with exactly one token and nothing else: HOST_MEMORY_FOUND if there
are, HOST_MEMORY_NONE if there are not.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: "HOST_MEMORY_NONE", scope: agent_text, expect: present }
  - { transcript_contains: "HOST_MEMORY_FOUND", scope: agent_text, expect: absent }
  - { transcript_contains: "[tool-call", expect: absent }
```

## Behavioral expectations
- Answered with the single token and called no tool.
