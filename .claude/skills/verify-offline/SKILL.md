---
name: verify-offline
description: Prove Stapler makes zero network requests and ships zero permissions. Use before any release or store submission, when implementing or checking QA-03, when asked to verify the privacy claim, whether anything is uploaded, whether the bundle contains remote references, or whether the manifest still shows no install warning. Also use after adding any dependency, since a transitive package is the most likely way a network call gets in.
---

# Verifying the zero-network and zero-permission claims

The product's entire differentiator is that these two claims are _verifiable_
([docs/PLAN.md](../../../docs/PLAN.md) §5.4). Check all four layers — the per-file hook only
covers source we wrote by hand.

## 1. Source (fast, already automated)

`.claude/hooks/check-invariants.mjs` runs on every write. To sweep the whole tree at once,
grep `src/` for: `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`,
`https://` in import/`src`/`href`/`@import` position, and the known hosts
(`fonts.googleapis`, `jsdelivr`, `unpkg`, `cdnjs`, analytics, `sentry.io`).

Expected exception: `src/core/ocr/` may fetch the language model once, behind explicit user
confirmation.

## 2. Built bundle — where dependencies betray you

A transitive dependency is the most likely source of a violation, and it will not appear in
our source. After `pnpm build:ext`, grep `dist/ext` for `http://`, `https://`, `fetch(`, and
each known host. Investigate every hit: a URL in a comment or license header is fine, a URL
in a fetch call is a release blocker.

Also confirm no source map or asset references a remote origin.

## 3. Runtime — the authoritative check

This is `QA-03`, and it is the only layer that proves the claim rather than suggesting it.

Load the built extension in Playwright with a persistent context, attach a request listener
before navigating, and drive every tool flow: import → operate → export.

**Assertion:** every observed request URL is `chrome-extension://`, `blob:`, or `data:`.
Anything else fails.

Then prove the test actually works: temporarily add a `fetch('https://example.com')` and
confirm the suite goes red. A green test that cannot fail is worse than no test.

The chrome-devtools MCP tools (`list_network_requests`) are useful for interactive
confirmation while developing.

## 4. Manifest and install prompt

- `permissions`, `host_permissions`, `optional_permissions` all empty or absent
- no `content_scripts`
- CSP permits no remote code
- Load unpacked in Chrome and confirm the install dialog raises **no** permission warning

## Reporting

State plainly which layers you checked and what you observed. If you could not run the
runtime check, say that — do not report the claim as verified on the strength of a grep. If
a violation exists, name the file, the line, and whether it is ours or a dependency's.
