# Contributing to libi

Thanks for your interest in libi. Right now the most valuable thing you can send us is a
good **issue** — see below. **Pull requests are closed while libi is in beta.**

When contributions do open, they will be subject to the
[Contributor License Agreement](./CLA.md). libi is free and open source under
[GPL-3.0-only](./LICENSE) — see [LICENSING.md](./LICENSING.md).

## Pull requests are closed right now

**libi is in beta, and I'm not accepting outside pull requests right now.** PRs opened
against this repository will be closed without review.

This isn't a judgement on anyone's work. The architecture is still moving quickly, and
I'm still settling code ownership, testing standards, and the review workflow. I'd rather
not have you spend hours on a patch I can't merge, or leave you sitting on a branch that
goes stale underneath you.

I will announce it here when I open up for contributions, and update this file at the
same time.

## Issues — open, and genuinely appreciated

Bug reports, reproductions, crashes, feature requests, and rough edges you hit while
actually using libi are the most useful thing you can send us right now. We read them and
we'll do our best to address them.

- [Open an issue](https://github.com/Nagellabs/libi/issues)
- Before filing a bug, check open and recently-closed issues to avoid duplicates.
- A reproduction (steps, a piece, a log excerpt from `~/.libi/logs/libi.log`) makes a
  report dramatically more actionable.

For anything security-sensitive, please email admin@nagellabs.com rather than opening a
public issue — see [SECURITY.md](./SECURITY.md) for the full disclosure process and threat
model.

## Contributor agreements

libi uses **two** lightweight instruments, which do different jobs. Both apply to code
contributions once PRs open; neither applies to filing issues.

- **The DCO** (`git commit -s`) is a per-commit statement that you wrote the code, or
  otherwise have the right to submit it. It grants nothing — it's a provenance record.
- **The [CLA](./CLA.md)** is the license grant. It lets libi ship your contribution under
  the project's license today, and under other license terms in the future — including
  other open source licenses and commercial terms. You keep your copyright and can use
  your own work however you like.

As a condition of that grant, we commit to continuing to make your contribution available
under the open source license that applied when you submitted it — see
[`CLA.md`](./CLA.md) §4.

## Developer Certificate of Origin (DCO)

By signing off your commits, you're certifying the
[Developer Certificate of Origin v1.1](https://developercertificate.org/) — the standard,
lightweight alternative to a CLA used by the Linux kernel, Docker, GitLab, and many
others. The full text is below for reference:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

Configure git once with `git config --global user.name "Your Name"` and
`git config --global user.email "you@example.com"`, then sign off each commit with
`git commit -s`.

## Code style

These apply to the codebase generally — useful if you're working in a fork, and the
standard we'll hold PRs to when they open.

- TypeScript, strict. Match the surrounding file's conventions.
- No `console.*` in server / MCP / agent code — use the pino loggers (see
  [AGENTS.md](./AGENTS.md) → Conventions).
- Always add `cursor-pointer` to interactive elements (the base-ui `Button` doesn't set it
  by default).
- Prefer editing existing files over adding new ones.
- Add tests when you fix a bug or add a feature; the rules are in
  [AGENTS.md](./AGENTS.md) → Testing.
- Run `npm test` before pushing. For UI changes, also boot `npx @nagellabs/libi` and exercise the
  change manually.

## Asking questions

Open a discussion thread or email support@nagellabs.com for general questions, or
admin@nagellabs.com for licensing-specific questions.
