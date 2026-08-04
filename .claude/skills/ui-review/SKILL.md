---
name: ui-review
description: Review Stapler UI against the design system before considering a UI ticket done. Use after building or changing any component, panel, view, or layout — the tool rail, page grid, thumbnails, options panel, action bar, drop zone, command palette, sliders, modals — or when asked whether the UI matches the design, to check dark mode, contrast, keyboard access, or accessibility of a screen.
---

# UI review against the design system

Source of truth: [docs/DESIGN-ADAPTATION.md](../../../docs/DESIGN-ADAPTATION.md).
Upstream reference: [DESIGN.md](../../../DESIGN.md) (read-only).

Run every check. Report findings as a list with file:line, most severe first — do not
silently fix and move on, and do not report "looks good" without having actually looked.

## Tokens

- [ ] No colour literal outside `src/ui/styles/tokens.css` (the hook catches this, but check
      `currentColor` misuse and inline `style=` attributes too)
- [ ] Spacing on the 8px grid; 4px only inside a control
- [ ] Radius, motion durations, and easing from tokens — no ad-hoc `transition: 0.3s ease`
- [ ] Type from the app ramp in §3.2. Negative letter-spacing only at ≥20px. The upstream
      display ramp (28px–80px) belongs on the website twin only

## Colour discipline — the one most likely to be wrong

- [ ] Filled accent (`--primary`) appears **only** on the single primary CTA in the action
      bar. Focus rings use `--primary-focus`. Nowhere else.
- [ ] The area behind a PDF page uses `--doc-bg` and is never tinted with accent
- [ ] **A page is white in both themes.** Dark mode must never invert document content
- [ ] Dark mode gets depth from surface steps and hairlines, not shadows

## Layout roles

- [ ] Left rail = which tool. Right panel = tool parameters. Bottom bar = commit. Never mixed
- [ ] Tool declares `canvasMode: 'grid' | 'single'` and gets the right one
- [ ] Modals only for destructive confirmation and the redaction verification report
- [ ] Breakpoints exercised: <1100px panel → bottom sheet, <800px rail → icons. No clipped
      control, no horizontal body scroll at any width

## States and interaction

- [ ] Every interactive element has hover, active, focus-visible, and disabled states in both
      themes; every thumbnail also has selected, dragging, processing, error
- [ ] Empty, loading (skeleton), and error states exist — not just the happy path
- [ ] Long operations show determinate progress and a working cancel

## Accessibility

- [ ] Keyboard-only: reach and operate everything, including grid selection and page reorder
      (`⌥↑/↓` alternative to drag). Focus order sane, focus visible, no trap
- [ ] Icon-only controls have accessible names; page grid announces page number and selection
- [ ] Contrast AA in both themes for every pair actually rendered
- [ ] `prefers-reduced-motion` disables motion

## Verify, don't assume

Build it and look. The Playwright MCP tools can drive the real extension page — take
screenshots in both themes at both breakpoints, tab through the interface, and run axe-core.
A design review done only by reading CSS misses exactly the things design reviews are for.
