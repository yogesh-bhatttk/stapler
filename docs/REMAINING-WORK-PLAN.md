# Remaining work — status and implementation plan

Snapshot taken directly from `docs/TICKETS.md` on `master`, which remains the
single source of truth for per-ticket status. This file exists only to give
whoever picks this up next a single place to see what's left and how to
approach it, without re-deriving it from 92 ticket entries.

**Tally: 72 Done · 4 Partial · 16 Not started** (92 tickets total: the
original 72 plus the 20 new "EPIC-15 · v1.1 feature expansion" tickets added
this session).

## In-flight work not yet on master (do this first)

Two agents were mid-task when work was paused. Their worktrees still exist
and were deliberately left unmerged — check `git worktree list` and
`git branch --list 'worktree-agent-*'` before starting anything else, since
finishing these is far cheaper than redoing them:

- **ANN-03 · Search and highlight** — implementation is **complete and
  verified** (`pnpm check` clean, 347/347 unit tests, e2e passing) sitting on
  worktree branch `worktree-agent-ab79336dc5843c90f`, uncommitted in that
  worktree's working tree as of the pause. To finish: `cd` into that
  worktree, `git add -A` (excluding the `node_modules` symlink), commit, then
  from the main checkout `git merge worktree-agent-ab79336dc5843c90f
  --no-edit`, resolve any conflicts (recent merges have needed small import-
  list merges in `src/ui/tools/commit.ts` / `src/core/operations.ts` — nothing
  structural), run `pnpm check && pnpm test && pnpm test:e2e`, then delete the
  worktree and branch.
- **OCR-01 · Tesseract integration** — was still running (general-purpose
  agent, worktree `worktree-agent-aa5957858ee912aab`) when paused. Check its
  state before resuming: it may have finished, failed, or still be mid-task.
  If resuming, send it a message via the agent-resume mechanism rather than
  restarting from scratch — it will have useful context loaded already.

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

## Process notes for whoever continues this

- Committing ticket text to `docs/TICKETS.md` **before** dispatching any
  worktree-isolated agent is mandatory — `isolation: worktree` forks from the
  last committed HEAD, not the working tree. This session lost significant
  time to that exact mistake once; don't repeat it.
- Batch concurrent agents in groups of ~3, not 9+ at once — this session hit
  an account-wide API spend limit doing 9 at once, which killed all 9
  simultaneously with no partial credit for the ones close to finishing.
- Merge and verify (`pnpm check && pnpm test && pnpm test:e2e`) after each
  ticket lands, not after a whole batch — conflicts are far easier to
  resolve one at a time.
- `.claude/worktrees/` is excluded from `pnpm check`'s prettier pass and from
  git (see `.prettierignore`/`.gitignore`) — don't re-add it by accident.
