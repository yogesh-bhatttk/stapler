# Stapler — offline PDF toolkit (Chrome MV3 extension + static web twin)

Everything runs client-side in one extension page. No server, no accounts, no upload.

## Read before non-trivial work

- [docs/PLAN.md](docs/PLAN.md) — architecture, stack decisions, roadmap cut lines, NFRs
- [docs/TICKETS.md](docs/TICKETS.md) — 72 tickets with acceptance criteria; work is tracked here
- [docs/DESIGN-ADAPTATION.md](docs/DESIGN-ADAPTATION.md) — tokens, layout, component specs
- [DESIGN.md](DESIGN.md) — upstream `linear.app` design system. **Read-only. Never edit.**

## Hard invariants

These are the product, not preferences. A `PostToolUse` hook
(`.claude/hooks/check-invariants.mjs`) enforces all four on every write.

1. **Zero network at runtime.** No `fetch`, no XHR, no WebSocket, no CDN import, no webfont,
   no telemetry, ever. There are exactly two exceptions, both a model download made once on
   explicit user confirmation from a pinned URL, and both confined to their own directory:
   the OCR language model in `src/core/ocr/` (OCR-01), and the face-detector weights in
   `src/core/faceblur/` (RED-08). The inference *engines* for both are bundled, never
   fetched — remote code is forbidden outright, whatever the user consents to.
2. **Zero permissions in the Chrome/Edge manifest.** `manifest.json` ships with empty
   `permissions` and no `host_permissions` or content scripts, so Chrome's install dialog
   shows no warning. The Firefox build is the explicit exception: it adds `tabs` so the
   extension can query tabs there. Use the File System Access API instead of the
   `downloads` permission.
3. **No raw colours.** Every colour comes from `var(--token)` defined in
   `src/ui/styles/tokens.css`. No hex, `rgb()`, or `hsl()` literals anywhere else.
4. **Layer boundary.** Only `src/platform/` and `src/background/service-worker.ts` may reference `chrome.*`. 
   `core/` and `ui/` go through the platform adapter so the same code builds as extension and website.

## Conventions

- TypeScript strict. No `any` without a comment justifying it.
- Heavy work goes in a worker (`src/workers/`), never on the main thread. Budget: no task
  blocks the main thread for >50ms.
- Every long operation is cancellable via `AbortSignal` and reports determinate progress.
- Never silently corrupt a document. On unrecoverable error, return the original bytes and
  surface a clear message. Unsupported constructs (XFA, encrypted, JBIG2/JPX) are detected
  and explained, never half-processed.
- Never emit output larger than the input on a "compress" operation — fall back and say so.
- Colour tokens, spacing, radius, motion: `docs/DESIGN-ADAPTATION.md` §3. 8px grid.
- Both themes and full keyboard operation are part of every UI ticket, not a later pass.

## Commands

`pnpm` is the intended package manager but only `npm` is installed here — either
`npm i -g pnpm` or substitute `npm run`.

```
pnpm dev          # HMR dev server for editor.html
pnpm build:ext    # unpacked extension → dist/ext
pnpm build:web    # static site → dist/web
pnpm check        # eslint + prettier + tsc --noEmit
pnpm test         # vitest
pnpm test:e2e     # playwright, includes the zero-network assertion
```

## Working style for this repo

- Work ticket by ticket. Quote the ticket ID in the commit subject (`OPS-01: merge`).
- Build the fixture corpus (`QA-01`) before feature work — every hard bug here is an edge
  case, and edge cases you haven't collected can't be tested.
- Verify acceptance criteria against real output bytes, not against intent. "It should work"
  is not a passing criterion.
- Report honestly. If an acceptance criterion is unmet, say which one and why.
- Don't add features that aren't in a ticket. `docs/PLAN.md` §1.1 lists deliberate non-goals
  with reasons — pixel-perfect PDF↔Office fidelity, password removal, accounts, analytics.
  (Best-effort, beta-labeled PDF↔Word/Excel/PowerPoint conversion is in scope as CNV-08..13.)
