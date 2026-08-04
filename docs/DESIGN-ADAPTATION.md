# Design System — Adaptation Layer

**Base:** [`../DESIGN.md`](../DESIGN.md) — the `linear.app` entry from
[voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md), downloaded
unmodified. Read it first; this document only records what we change and what we add.

---

## 1. Why Linear

Judged against what this app actually is — a document editor with a tool rail, a thumbnail
canvas, and a parameters panel:

1. **Its navigation model is already ours.** Sidebar + dense scannable list + contextual
   panel + command palette + minimal chrome maps 1:1 onto tool rail → page canvas → tool
   options. Nothing needs translating.
2. **Near-monochrome, single accent.** In a document editor the PDF page must be the only
   thing carrying color. Linear confines its lavender `#5e6ad2` to focus rings and
   intentional CTAs — the exact discipline required. (Figma's multi-color language, by
   contrast, would compete with document content.)
3. **It reads as expensive.** A free tool must beat the "free means janky" assumption in
   one screenshot. Surface steps plus hairline borders are the cheapest credible signal of
   paid-app quality.

Rejected: **Notion** (content-editor language, weak on dense controls), **Vercel** (right
neutrality, too few surface levels for four stacked panels), **Figma** (right structure,
wrong color discipline), **Raycast/Supabase/VoltAgent** (dark-only, dev-audience),
**Apple** (whitespace-first, wrong for dense tooling).

---

## 2. Deviations from upstream

The upstream file is derived from Linear's **marketing site**: a `#010102` canvas, 80px
display type, and pricing-card/testimonial/logo-tile components. Unusable as-is for a
dense application. Seven deliberate changes:

| #   | Deviation                                                                         | Reason                                                                    |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | **Light theme is the default**; dark is opt-in and follows `prefers-color-scheme` | Document work happens on white. Upstream is dark-first marketing          |
| 2   | **App-scale type ramp** replaces the display ramp (max 20px in-app)               | 80px/-3px tracking has no place in a tool panel                           |
| 3   | **Negative letter-spacing only at ≥20px**                                         | Below that it hurts legibility at UI density                              |
| 4   | **Neutral document canvas**; accent reserved for interactive state only           | Never tint the area behind a PDF page; never accent document chrome       |
| 5   | **Added `danger` and `warning` tokens**                                           | Upstream defines only `semantic-success`; we have destructive ops         |
| 6   | **System font stack, no webfont**                                                 | A font CDN request would break the zero-network guarantee (see PLAN §5.4) |
| 7   | **Added an app component set** (rail, thumbnails, sliders, palette, action bar)   | Upstream components are marketing surfaces                                |

Upstream's marketing components (pricing card, testimonial, logo tile) are **retained
unchanged for the website twin only**, where they are exactly right.

---

## 3. Tokens

Emitted as CSS custom properties in `src/ui/styles/tokens.css`. Dark values come from
upstream; light values are derived from upstream's `inverse-*` tokens, expanded into a
full surface ramp.

### 3.1 Color

| Token                 | Light     | Dark (upstream) |
| --------------------- | --------- | --------------- |
| `--canvas`            | `#ffffff` | `#010102`       |
| `--surface-1`         | `#f9f9fb` | `#0f1011`       |
| `--surface-2`         | `#f4f5f8` | `#141516`       |
| `--surface-3`         | `#eeeff2` | `#18191a`       |
| `--surface-4`         | `#e8e9ee` | `#191a1b`       |
| `--hairline`          | `#e6e7eb` | `#23252a`       |
| `--hairline-strong`   | `#d3d5da` | `#34343a`       |
| `--hairline-tertiary` | `#c3c5cc` | `#3e3e44`       |
| `--ink`               | `#08090a` | `#f7f8f8`       |
| `--ink-muted`         | `#3c4149` | `#d0d6e0`       |
| `--ink-subtle`        | `#6f7076` | `#8a8f98`       |
| `--ink-tertiary`      | `#8a8f98` | `#62666d`       |
| `--primary`           | `#5e6ad2` | `#5e6ad2`       |
| `--primary-hover`     | `#4c56c0` | `#828fff`       |
| `--primary-focus`     | `#5e69d1` | `#5e69d1`       |
| `--on-primary`        | `#ffffff` | `#ffffff`       |
| `--success`           | `#1f8a38` | `#27a644`       |
| `--warning`           | `#b26b00` | `#f5a623`       |
| `--danger`            | `#c8353a` | `#e5484d`       |

**Document-specific tokens** — the one place we diverge hardest from a marketing system:

| Token          | Light                        | Dark                       | Rule                                                               |
| -------------- | ---------------------------- | -------------------------- | ------------------------------------------------------------------ |
| `--doc-bg`     | `#eceef1`                    | `#0a0a0b`                  | The void behind pages. Always neutral, never accented              |
| `--doc-page`   | `#ffffff`                    | `#ffffff`                  | **A page is always white in both themes.** Never invert a document |
| `--doc-shadow` | `0 1px 3px rgba(8,9,10,.14)` | `0 1px 3px rgba(0,0,0,.6)` | Page lift                                                          |
| `--doc-select` | `--primary` @ 100% ring      | same                       | 2px selection ring on thumbnails                                   |
| `--doc-redact` | `#0a0a0b`                    | `#0a0a0b`                  | Redaction fill; opaque, identical in both themes                   |

Light-mode `success`/`warning`/`danger` are darkened from the dark-mode values to hold
AA contrast on white. Verify all pairs in `DS-02`.

### 3.2 Typography

Stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`
Mono: `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`

| Role          | Size | Weight | Line height | Tracking |
| ------------- | ---- | ------ | ----------- | -------- |
| `page-title`  | 20px | 600    | 1.25        | -0.3px   |
| `section`     | 15px | 600    | 1.35        | 0        |
| `body`        | 14px | 400    | 1.50        | 0        |
| `body-strong` | 14px | 500    | 1.50        | 0        |
| `small`       | 13px | 400    | 1.45        | 0        |
| `micro`       | 12px | 500    | 1.35        | 0.1px    |
| `mono`        | 12px | 400    | 1.45        | 0        |

Upstream's `display-xl` … `headline` ramp is used **only** on the website twin and the
first-run welcome screen.

### 3.3 Radius, spacing, elevation, motion

Radius and spacing scales are taken from upstream unchanged (`xs 4` → `pill 9999`;
`xxs 4` → `section 96`). Everything sits on an **8px grid**; 4px is permitted only inside
controls.

| Elevation    | Light                          | Dark                                |
| ------------ | ------------------------------ | ----------------------------------- |
| `--shadow-1` | `0 1px 2px rgba(8,9,10,.06)`   | none — use `--surface-2` + hairline |
| `--shadow-2` | `0 4px 12px rgba(8,9,10,.08)`  | `0 4px 12px rgba(0,0,0,.5)`         |
| `--shadow-3` | `0 12px 32px rgba(8,9,10,.12)` | `0 12px 32px rgba(0,0,0,.6)`        |

In dark mode, depth comes from surface steps and hairlines, not shadows — this is core to
how Linear reads.

Motion: `--dur-fast 120ms`, `--dur-base 160ms`, `--dur-slow 220ms`, easing
`cubic-bezier(0.16, 1, 0.3, 1)`. All motion disabled under `prefers-reduced-motion`.

### 3.4 Density

Default control height **32px**; compact **28px**; rail item **32px**; touch targets
never below 32×32. Table/list rows 36px.

---

## 4. Layout and navigation

Two surfaces only. Resist adding a third.

### 4.1 Home / launcher

```
┌──────────────────────────────────────────────────────────┐
│ Stapler                    ⌘K   ◐ theme   ⓘ Offline · 0  │  48px top bar
├──────────────────────────────────────────────────────────┤
│                                                          │
│        ╭──────────────────────────────────────╮          │
│        │   Drop PDFs or images here           │          │  drop zone
│        │   or click to choose files           │          │  dashed hairline
│        ╰──────────────────────────────────────╯          │
│                                                          │
│   ⌕ Search tools                                         │
│   ORGANIZE      Merge · Split · Organize · Insert         │  tool grid,
│   CONVERT       Images→PDF · PDF→Images · Markdown        │  grouped,
│   OPTIMIZE      Compress · Scan cleanup · Crop            │  keyboard
│   DOCUMENT      Sign · Fill · Redact · Metadata           │  navigable
│                                                          │
│   RECENT        contract.pdf · scan-03.pdf                │
└──────────────────────────────────────────────────────────┘
```

### 4.2 Workspace

```
┌──────────────────────────────────────────────────────────┐
│ ← Stapler   contract.pdf ×  scan.pdf ×   ⌘K  ◐  Offline  │  48px
├───────────┬──────────────────────────────┬───────────────┤
│ ORGANIZE  │                              │ COMPRESS      │
│ ▸ Merge   │   ┌────┐ ┌────┐ ┌────┐       │               │  right panel
│ ▪ Organize│   │ 1  │ │ 2  │ │ 3  │       │ Quality  ──●─ │  300px
│ ▸ Split   │   └────┘ └────┘ └────┘       │ 75%           │  contextual;
│ CONVERT   │   ┌────┐ ┌────┐              │               │  hidden when
│ ▸ …       │   │ 4  │ │ 5  │              │ ▸ Preview     │  tool has no
│           │   └────┘ └────┘              │   page 1      │  parameters
│ rail      │                              │               │
│ 224px     │   doc canvas, --doc-bg       │ 4.2MB → 1.1MB │
│ collapses │   virtualized, zoomable      │ −74%          │
│ to 56px   │                              │               │
├───────────┴──────────────────────────────┴───────────────┤
│ 5 pages · 2 selected          [Cancel]  [Compress & Save]│  56px action bar
└──────────────────────────────────────────────────────────┘
```

**Rules:**

- Left rail = _which tool_. Right panel = _tool parameters_. Bottom bar = _commit_.
  Never mix these roles.
- The primary CTA lives **only** in the action bar, and is the only filled-accent element
  on screen.
- Center canvas has two modes: **grid** (page thumbnails, for page-level ops) and
  **single-page** (for sign, redact, annotate, crop). Tools declare which they need.
- `⌘K`/`Ctrl+K` command palette reaches every tool and action. Upstream-native pattern,
  cheap to build, and the main power-user affordance.
- Modals only for destructive confirmation and the redaction verification report.
  Everything else is inline.
- Routing: hash routes (`#/`, `#/tool/merge`) so back/forward work.
- Responsive: <1100px right panel becomes a bottom sheet; <800px rail collapses to icons.

### 4.3 The offline badge

A persistent top-bar chip — `Offline · 0 requests` — with a click-through explaining that
nothing is uploaded and inviting the user to verify in DevTools. This is the product's
core claim, so it stays visible at all times. Uses `--success` at low emphasis; never
animated.

---

## 5. Components to build (`DS-03`)

Primitives: `Button` (primary/secondary/tertiary/danger/ghost, 3 sizes), `IconButton`,
`Input`, `NumberStepper`, `Select`, `Toggle`, `Checkbox`, `Radio`, `Slider`,
`SegmentedControl`, `Tooltip`, `Badge`, `Chip`, `Spinner`, `ProgressBar` (determinate +
cancel), `Toast`, `Modal`, `ContextMenu`, `Tabs`, `EmptyState`, `Skeleton`.

App-specific: `TopBar`, `FileTabs`, `ToolRail` + `RailGroup` + `RailItem`, `DropZone`
(idle/hover/active/reject), `ThumbnailCard` (default/hover/selected/dragging/processing/
error), `PageGrid` (virtualized, multi-select, keyboard reorder), `SinglePageView` (zoom,
pan, overlay layer), `OptionsPanel` + `PanelSection`, `ActionBar`, `CommandPalette`,
`CompareSlider` (before/after), `SizeDelta` (`4.2MB → 1.1MB · −74%`), `VerificationReport`
(redaction results table), `ShortcutSheet`, `OfflineBadge`.

Every component ships with all interaction states specified in both themes, keyboard
behaviour, and an accessible name. `DS-04` renders them all in a
`#/dev/components` gallery route for visual review.
