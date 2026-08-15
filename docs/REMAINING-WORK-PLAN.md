# Remaining work — status and implementation plan

Snapshot taken directly from `docs/TICKETS.md` on `master`, which remains the
single source of truth for per-ticket status. This file exists only to give
whoever picks this up next a single place to see what's left and how to
approach it, without re-deriving it from 92 ticket entries.

**Tally: 81 Done · 4 Partial · 7 Not started** (92 tickets total: the
original 72 plus the 20 new "EPIC-15 · v1.1 feature expansion" tickets added
this session).

## Before you touch anything — read this whole section

This project has hard invariants enforced by a `PostToolUse` hook and by
`pnpm check`, and this session made real mistakes against them that cost real
time to recover from. If you are a new agent with no memory of how this
document was produced, do the following **in order**, before writing or
deleting anything:

1. **Read `CLAUDE.md` at the repo root in full.** It is not optional
   background — it overrides default behavior, and it lists deliberate
   non-goals (PDF→Word, Office→PDF, password *removal*, accounts, analytics)
   that nothing in this plan reverses. If a task here seems to conflict with
   it, `CLAUDE.md` wins; stop and flag it rather than guessing.
2. **Run `git worktree list` and `git branch --list 'worktree-agent-*'`
   before assuming anything about repo state.** Two worktrees may still
   exist from this session with real, uncommitted, unmerged work in them
   (exact paths and contents below, as of the last time this file was
   updated — verify they still exist and re-check their `git status`
   yourself, since this file goes stale and they may have already been
   merged or resumed since). **Do not run `git worktree remove --force` or
   any destructive git command against them without first inspecting
   `git status`/`git diff` inside each one.** One of them alone represents
   roughly 15 minutes of a large agent's real work; force-removing it
   without committing first destroys that permanently.
3. **Run `pnpm check && pnpm test && pnpm test:e2e` on `master` first**, to
   get a known-good baseline before changing anything. If any of those are
   red on a clean `master`, something happened after this file was written —
   stop and figure out what, don't build on top of a red baseline.
4. **Never mark a ticket Done in `docs/TICKETS.md` without pasting real
   command output as evidence in the same edit.** Every prior "Done" in this
   file was earned by an agent that ran the actual test suite and quoted the
   result. "It should work" or "the code looks right" is explicitly called
   out in `CLAUDE.md` as not a passing criterion — an agent that skips this
   will produce ticket entries the next reader can't trust, which is worse
   than leaving the ticket honestly "Not started."
5. **Do not attempt to "fix" CMP-03's six skipped image categories**
   (Separation/DeviceN, colour-key masks, Matte, ImageMask, JPX/JBIG2,
   sub-byte depth). They are read `docs/TICKETS.md`'s CMP-03 entry in full —
   they are deliberately unimplemented because doing so naively would
   violate the "never corrupt a document" invariant, not an oversight.
6. **If you are going to dispatch a sub-agent into an isolated git worktree**
   (the `isolation: "worktree"` option, if your tooling has an equivalent),
   remember: **the worktree forks from the last *committed* HEAD, not from
   your uncommitted working tree.** This session lost real time when several
   agents correctly refused to invent specs because the tickets they were
   asked to implement existed only as *uncommitted* edits in the main
   checkout. Commit first, dispatch second — always.
7. **Keep concurrent agent batches small (≈3), not large (9+).** This
   session dispatched 9 worktree-isolated agents simultaneously once and hit
   an account-wide API spend limit that killed all 9 at once, with no
   partial credit for the ones close to finishing. Batches of 3, merged and
   verified before the next batch, cost less in wasted work even though they
   feel slower.
8. **Merge and run the full verification (`pnpm check && pnpm test &&
   pnpm test:e2e`) after every single ticket lands, not after a whole
   batch.** Conflicts and regressions are far cheaper to find one commit at
   a time than after five have piled up.

## In-flight work not yet on master ✅ RESOLVED

Both previously in-flight items are now **fully merged into master**:

- **ANN-03 · Search and highlight** — ✅ Done. Merged via `worktree-agent-ab79336dc5843c90f` (commit `20b4448`). Annotate panel gains a "Find and highlight text" field; text layer extraction and highlight geometry live in `src/core/highlight.ts`.
- **OCR-01 · Tesseract integration** — ✅ Done. Merged via `worktree-agent-aa5957858ee912aab` (commit `4f404a7`). Lazy `tesseract.js` with user-confirmed model download. Code in `src/core/ocr/`, `src/ui/tools/ocr/`, `src/core/workers/ocr.worker.ts`. The stale worktree at `.claude/worktrees/agent-aa5957858ee912aab` may be removed with `git worktree remove --force` followed by `git branch -D worktree-agent-aa5957858ee912aab`.

## Partial tickets (4)

These are **not gaps to close** in the usual sense — each is honestly
bounded by something outside code, already documented in its own
`docs/TICKETS.md` entry. Re-read the entry before touching any of them;
summarized here only for triage:

| Ticket | Why it's Partial | What would close it |
|---|---|---|
| **DOC-05** Export pipeline | Save-over-original can't be driven by Playwright (no native file-picker automation) | QA-05's manual pass — a person, a checklist, not more code |
| **CMP-03** Surgical re-encode | Six image categories (Separation/DeviceN, colour-key masks, Matte, ImageMask, JPX/JBIG2, sub-byte depth) are *deliberately* skipped, not half-built — attempting them naively would violate the "never corrupt" invariant | Nothing, by design. CMP-05 (the other half — quality preview) is now Done, so this is as finished as it should be |
| **DIST-03** Website twin | All 5 landing-page routes build and work; Lighthouse ≥95 and the actual Cloudflare Pages deploy can't be run in this environment | A person runs Lighthouse against a real deploy |
| **DIST-04** Edge/Firefox | Both builds (`dist/ext`, `dist/firefox`) emit correctly and are unit-tested; loading them in real Firefox/Edge and surviving store review can't be done here | A person loads each build in the real browser, then submits |

**QA-05** (External viewer compatibility checklist, P0, Not started) is the
common thread above — it's the one ticket that would let a person close out
DOC-05's automation gap and give DIST-03/DIST-04 their real-browser check in
one pass. If you only do one non-code thing next, do this: open a
representative output from each P0 tool in Chrome's own viewer, Acrobat
Reader, macOS Preview, and Firefox's pdf.js; record pass/fail per
tool-per-viewer in `RELEASE_CHECKLIST.md`'s existing §1 checkbox for it.

## Not started (7) — grouped by what they need

### Completed in this session ✅

- **DOC-09 · Contact sheet export** (`S` `P2`) — ✅ Done. `contactSheetExport` tiles page thumbnails into a new PDF with configurable columns. Tested in `tests/unit/contact-sheet.test.ts`.
- **DS-09 · Custom keyboard shortcut remapping** (`S` `P2`) — ✅ Done. Local IndexedDB shortcut remapping store, conflict detection, reset-to-default, and shortcuts UI. Tested in `tests/unit/shortcuts.test.ts`.
- **BAT-03 · Templated batch output filenames** (`S` `P2`) — ✅ Done. Templated pattern token substitution (`{basename}`, `{index}`, `{date}`) and deduplication in `src/core/batch-filename.ts`. Tested in `tests/unit/batch-filename.test.ts`.

### Independent, small, code-only (good next picks — no cross-ticket dependency)

- **CMP-06 · Compression report export** (`S` `P2`) — sidecar text/JSON
  breakdown alongside CMP-04's on-screen summary. Pure reporting; no new
  compression logic.
- **ANN-04 · Export annotation summary** (`S` `P2`) — collect ANN-01 sticky
  notes/comments into a printable list. Pure reporting over an existing data
  model.

### Independent, medium (need a bit more design care)

- **ANN-05 · Export visual diff** (`S` `P2`) — extend the Compare tool
  (ANN-02) to export its highlighted-diff view as a new PDF.

### Depends on another ticket in this list

- **SGN-06 · Create form fields** (`L` `P2`) — draws *new* AcroForm fields
  (SGN-03 only fills existing ones). Largest remaining ticket; budget
  accordingly. No hard dependency on anything else here, but pairs naturally
  with SGN-05 (flatten, now Done) as the two halves of a "build then finalize
  a form" story.
- **OCR-02 · Folder index and search** (`L` `P2`) — hard-blocked on OCR-01
  landing first (needs its extracted text layer). Do not start until OCR-01
  is merged and verified.
- **OCR-03 · Table extraction → CSV/XLSX** (`L` `P2`, beta) — also blocked on
  OCR-01. Sequence after OCR-02, since both compete for the same "what do we
  do with OCR'd text" design decisions.

## Suggested order

1. ~~Finish and merge ANN-03 and OCR-01~~ — **Done**.
2. QA-05 manual pass (closes DOC-05, gives real evidence for DIST-03/DIST-04).
3. ~~ACC-01~~ — **Done**.
4. The remaining small independent P2 tickets (`DOC-09`, `DS-09`, `BAT-03`, `CMP-06`, `ANN-04`, `ANN-05`), in worktree-isolated parallel batches of 3 — merge and `pnpm check && pnpm test && pnpm test:e2e` after every batch.
5. SGN-06, then OCR-02 → OCR-03 (OCR-01 now confirmed merged and green — these are unblocked).

## One more environment gotcha, not covered above

`.claude/worktrees/` is deliberately excluded from `pnpm check`'s prettier
pass and from git (see `.prettierignore`/`.gitignore`) — a leftover agent
worktree used to break `pnpm check` for everyone until this was fixed.
Don't remove that exclusion, and don't be surprised if a *very* old clone
without it fails `pnpm check` for a reason that has nothing to do with your
change.

If anything in this document contradicts what you find in `docs/TICKETS.md`
or the actual repo state, **trust the repo, not this file** — this is a
snapshot, not a live view, and its entire purpose is to save you rediscovery
time, not to be obeyed over reality.
