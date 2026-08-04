---
name: ticket
description: Implement or continue a Stapler ticket from docs/TICKETS.md. Use whenever the request names a ticket ID (F-01, DOC-03, OPS-01, CMP-03, RED-02, SGN-02, SCN-01, DS-04, QA-01, NFR-02, DIST-01, …), says "next ticket", "pick up the next unblocked ticket", "work on the merge tool", or asks to implement any feature that has a ticket. Also use when asked which ticket comes next or whether a ticket is done.
---

# Implementing a Stapler ticket

## 1. Locate and read

Read the ticket in [docs/TICKETS.md](../../../docs/TICKETS.md) verbatim. If the user said
"next", pick the lowest-priority-number ticket whose dependencies are complete, using the
critical-path graph at the bottom of that file.

Read the shared **definition of done** at the top of `TICKETS.md` — it applies to every
ticket in addition to the ticket's own criteria. Then read the sections of
[docs/PLAN.md](../../../docs/PLAN.md) the ticket references (§ numbers are cited inline).

For any UI work, read [docs/DESIGN-ADAPTATION.md](../../../docs/DESIGN-ADAPTATION.md) §3–§5
first. Do not invent tokens, spacing, or components.

## 2. Check dependencies honestly

If a dependency ticket isn't actually complete, say so and either do that one first or
stub the boundary explicitly — do not silently build on something that doesn't exist.

## 3. Implement

- Pure logic in `src/core/`, platform calls behind `src/platform/`, heavy work in
  `src/workers/`. `core/` must never import `chrome.*`.
- Write the unit test alongside the code, not after. Golden-file tests re-parse real output.
- Respect the four invariants in [CLAUDE.md](../../../CLAUDE.md). The `PostToolUse` hook
  will block on violations; if it fires, fix the cause rather than restructuring to evade it.

## 4. Verify against the acceptance criteria, one by one

Walk the ticket's AC list and produce evidence for each:

- Numeric criteria (sizes, timings, percentages) — run it and report the measured number.
- Output-correctness criteria — re-parse the produced PDF and assert page count, order, and
  text content. Never accept "it looks right".
- "Works in external viewers" — you cannot verify this yourself. Say so and add it to the
  `QA-05` manual checklist.
- Both themes and keyboard-only operation — actually exercise them, ideally via the
  Playwright MCP tools against the built extension.

Report each criterion as met / unmet / unverifiable-here, with the evidence. **An unmet
criterion is a normal outcome to report, not something to work around.**

## 5. Close out

Summarise: what changed, which files, which AC are green, what remains. If the ticket
revealed a genuine gap in `TICKETS.md` or `PLAN.md`, propose the doc edit rather than
quietly diverging from the plan.
