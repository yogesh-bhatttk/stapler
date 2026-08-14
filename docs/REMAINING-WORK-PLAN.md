# Remaining work — status and implementation plan

Snapshot taken directly from `docs/TICKETS.md` on `master`, which remains the
single source of truth for per-ticket status. This file exists only to give
whoever picks this up next a single place to see what's left and how to
approach it, without re-deriving it from 92 ticket entries.

**Tally: 72 Done · 4 Partial · 16 Not started** (92 tickets total: the
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

## In-flight work not yet on master (do this first)

Two agents were mid-task when work was paused, both forked from master at
commit `9fdc398` (master has since moved to `b80c4e4` — a docs-only commit,
so merging either back should be low-conflict). Their worktrees still exist
and were **deliberately left unmerged and uncommitted** — this is exactly
the kind of state a careless cleanup pass destroys, so read this section
fully before running any git command against either path. Re-run
`git worktree list` / `git status` inside each one yourself; the contents
below are a snapshot, not a guarantee of current state.

- **ANN-03 · Search and highlight** — implementation is **complete and
  verified** (`pnpm check` clean, 347/347 unit tests, e2e passing — see this
  ticket's own `docs/TICKETS.md` entry for the exact command output once
  merged) sitting **uncommitted** in worktree
  `.claude/worktrees/agent-ab79336dc5843c90f` (branch
  `worktree-agent-ab79336dc5843c90f`). Last known `git status` there:
  modified `docs/TICKETS.md`, `src/core/i18n/locales/en.json`,
  `src/core/operations.ts`, `src/core/workers/process.worker.ts`,
  `src/ui/tools/annotate/AnnotatePanel.tsx`, `src/ui/tools/annotate/state.ts`,
  `src/ui/tools/redact/RedactPanel.tsx`, `tests/e2e/tool-flows.spec.ts`; new
  `src/core/highlight.ts`, `tests/unit/highlight.test.ts`. To finish: `cd`
  into that worktree, `git add -A` (there is also an untracked
  `node_modules` — it's a symlink back to the main checkout's own
  `node_modules`, safe to leave out of the commit or delete, never commit
  it), commit, then from the main checkout run
  `git merge worktree-agent-ab79336dc5843c90f --no-edit`. Expect small
  import-list conflicts in `src/ui/tools/commit.ts` /
  `src/core/operations.ts` if other tickets landed on master since — resolve
  by combining both sides' imports, nothing structural. Then
  `pnpm check && pnpm test && pnpm test:e2e`, then delete the worktree
  (`git worktree remove --force <path>`) and branch (`git branch -D
  worktree-agent-ab79336dc5843c90f`) **only after** the merge is committed
  and green.
- **OCR-01 · Tesseract integration** — was still **running** (general-purpose
  agent, worktree `.claude/worktrees/agent-aa5957858ee912aab`, branch
  `worktree-agent-aa5957858ee912aab`, git-locked) when this session paused,
  and had spawned at least one sub-agent of its own. Last known `git status`
  there showed real, substantial, uncommitted work: modified `package.json`,
  `pnpm-lock.yaml`, `src/core/tools.ts`, `src/core/workers/index.ts`,
  `src/core/workers/process.worker.ts`, `src/ui/shell/OptionsPanel.tsx`,
  `src/ui/tools/commit.ts`; new `pnpm-workspace.yaml`, `src/core/ocr/`,
  `src/core/workers/ocr.worker.ts`, `src/ui/tools/ocr/`. **Do not assume this
  is finished or safe to discard.** Check whether the agent is still
  reachable (its resume mechanism) before touching its worktree; if it's
  gone and the worktree is orphaned, inspect `git diff` there carefully and
  decide whether to finish it yourself, resume a fresh agent against it, or
  restart the ticket from scratch — in that order of preference, since the
  existing work may be most of an `L`-sized ticket's effort. Remember: a
  prior attempt at this exact ticket left partial `tesseract.js` /
  `tesseract.js-core` / `idb-keyval` dependency additions in the **main**
  tree by accident (no worktree isolation that time) and those had to be
  reverted as unaudited — don't let that happen again; any new dependency
  needs its transitive tree checked for network calls before it's trusted,
  per the zero-network invariant.

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

## Not started (16) — grouped by what they need

### Independent, small, code-only (good next picks — no cross-ticket dependency)

- **OPS-13 · Flatten page background** (`S` `P2`) — solid-white or flat-tint
  background replacement, scan-cleanup-adjacent. Touches
  `src/core/workers/render.worker.ts`/`process.worker.ts` image-path code and
  a new cleanup-panel option. Verify pixel-sampled off-text on a fixture with
  a coloured background fill.
- **CNV-07 · Paste image as page** (`S` `P2`) — Clipboard API read → reuse
  CNV-01's image-to-PDF page composition. Small, self-contained; the main
  work is wiring `navigator.clipboard.read()` through the platform adapter
  (`src/platform/`) per the layer-boundary rule, with a clear refusal message
  when the clipboard holds no image.
- **DOC-08 · Linearize export** (`S` `P2`) — reorder the exported PDF's
  objects so page 1's content precedes later pages' in byte offset. Verify
  by re-parsing and diffing object byte offsets, not by trusting a "linearize"
  flag exists.
- **DOC-09 · Contact sheet export** (`S` `P2`) — grid of page thumbnails as
  one PDF/image. Reuse DOC-03's thumbnail cache; don't re-render pages.
- **DS-09 · Custom keyboard shortcut remapping** (`S` `P2`) — rebind any
  DS-08 shortcut, persisted in IndexedDB (F-06), conflict detection, reset
  action. Touches the shortcut sheet and wherever global key handling lives
  (`src/ui/shell/AppShell.tsx` per this session's earlier reading).
- **BAT-03 · Templated batch output filenames** (`S` `P2`) — `{basename}`/
  `{index}`/`{date}` tokens in BAT-01's batch filename field.
- **CMP-06 · Compression report export** (`S` `P2`) — sidecar text/JSON
  breakdown alongside CMP-04's on-screen summary. Pure reporting; no new
  compression logic.
- **ANN-04 · Export annotation summary** (`S` `P2`) — collect ANN-01 sticky
  notes/comments into a printable list. Pure reporting over an existing data
  model.

### Independent, medium (need a bit more design care)

- **ACC-01 · Alt-text editor for images** (`M` `P1`) — attach alt-text to
  image XObjects, written as real structure-tree/`/Alt` metadata on export
  (not just an in-app label — the AC requires it survive a re-import). This
  is the highest-priority item left after QA-05; worth doing before most of
  the P2 list above.
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

1. Finish and merge ANN-03 (already done, just needs merging) and check on
   OCR-01's state.
2. QA-05 manual pass (closes DOC-05, gives real evidence for DIST-03/DIST-04).
3. ACC-01 (highest remaining priority, P1).
4. The eight small independent P2 tickets, in any order, in worktree-isolated
   parallel batches of 3 like this session used — merge and
   `pnpm check && pnpm test && pnpm test:e2e` after every batch, not at the
   end, so a bad merge is caught immediately rather than compounding.
5. SGN-06, then OCR-02 → OCR-03 once OCR-01 is confirmed merged and green.

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
