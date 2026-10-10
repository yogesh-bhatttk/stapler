/**
 * DOC-04 — the virtualised page grid.
 *
 * What this replaces: a plain `pages.map()` that mounted every thumbnail, with
 * selection wired only for two tools, no shift-range or ⌘A, no keyboard reorder, and
 * a drop indicator that scaled the hovered tile instead of showing where the page
 * would land. On the 300-page fixture that is 300 canvases and 300 observers.
 *
 * Windowing here is row-based rather than library-driven: the column count is
 * derived from the measured width, so only the visible rows exist in the DOM while
 * the scrollbar still reflects the full document.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { RefObject } from 'preact';
import {
  deletePages,
  documents,
  movePages,
  rotatePages,
  selectAllPages,
  selectPageRange,
  setPageSelection,
  sources,
  togglePageSelection,
  type PageRef,
  type StaplerDoc
} from '../../core/store';
import {
  dropGapIndex,
  isRightToLeft,
  keyboardMoveTarget,
  logicalArrowKey
} from '../../core/reorder';
import { tPlural, useTranslation } from '../../core/i18n';
import { activeJob } from '../../core/notify';
import { refuseEditWhileBusy } from '../busy';
import { displayedAspectRatio } from '../../core/rotation';
import { Thumbnail } from '../components/Thumbnail';
import { eventMatchesShortcut, getEffectiveBinding, customShortcuts } from '../../core/shortcuts';
import { WatermarkOverlay } from '../tools/watermark/WatermarkOverlay';
import { watermarkSettings, hasWatermarkContent } from '../tools/watermark/state';
import { CropBoxPreview } from '../tools/crop/CropBoxPreview';
import { cropBoxes, type CropBox } from '../tools/crop/state';
import { withSlots } from '../i18nSlots';
import styles from './PageGrid.module.css';

/** Matches the `minmax()` floor below; both must change together. */
const MIN_TILE = 160;
const GAP = 24;
/** Rows kept mounted above and below the viewport, to hide scroll latency. */
const OVERSCAN_ROWS = 2;

/**
 * The rows to mount for a scroll position: those intersecting the viewport, plus
 * `OVERSCAN_ROWS` either side. `scrolled` is relative to the top of the grid.
 */
export function windowRows(
  scrolled: number,
  rowHeight: number,
  viewportHeight: number,
  rowCount: number
): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrolled / rowHeight) - OVERSCAN_ROWS);
  const last = Math.min(
    rowCount,
    Math.max(0, Math.ceil((scrolled + viewportHeight) / rowHeight) + OVERSCAN_ROWS)
  );
  return { first, last };
}

/**
 * The index holding the grid's single roving tab stop. Normally the focused
 * index; when that tile's row has been virtualised away, the first mounted tile
 * instead — otherwise no tile had `tabIndex=0` and Tab skipped the whole grid
 * (AUDIT-2026-10-10 UI10).
 */
export function rovingTabStop(focusIndex: number, firstIndex: number, mounted: number): number {
  if (mounted <= 0) return focusIndex;
  if (focusIndex >= firstIndex && focusIndex < firstIndex + mounted) return focusIndex;
  return firstIndex;
}

export interface PageGridProps {
  doc: StaplerDoc;
  selection: Set<string>;
  selectable: boolean;
}

export function PageGrid({ doc, selection, selectable }: PageGridProps) {
  const t = useTranslation();
  void customShortcuts.value;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ columns: 1, width: MIN_TILE, height: 0, offsetTop: 0 });
  /**
   * The scroll position, kept in a ref rather than state (DOC-04 scroll jank).
   * Setting state on every `scroll` event re-rendered the whole window — every
   * mounted cell and thumbnail — once per frame, and the resulting repaint and
   * re-layerisation cost ~8 ms of main thread per frame. `onScroll` now records
   * the position here and re-renders (via `bumpWindow`) only when the set of
   * mounted rows actually changes.
   */
  const scrollTopRef = useRef(0);
  const [, bumpWindow] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const lastClickedRef = useRef<string | null>(null);
  /**
   * Index whose tile still needs to receive DOM focus. Keyboard navigation targets an
   * index, not an element: on a virtualised grid the target row usually does not exist
   * in the DOM yet (this is why Home/End used to be dead keys — `querySelector` found
   * nothing and the handler gave up). We scroll the window to the target first, then
   * this effect focuses the tile on the render where it finally exists.
   */
  const pendingFocusRef = useRef<number | null>(null);

  /**
   * The aspect ratio of the tallest page in the document, used to size the grid rows
   * so no tile overflows. Each tile then renders at its own true aspect ratio.
   */
  const gridAspect = useMemo(() => {
    let minAspect = 1 / 1.414; // Default to portrait if unknown
    for (const page of doc.pages) {
      const source = sources.value[page.sourceDocId];
      const size = source?.pageSizes[page.sourceIndex];
      if (size) {
        const a = displayedAspectRatio(size.width, size.height, page.rotation);
        if (a < minAspect) minAspect = a;
      }
    }
    return minAspect;
  }, [doc.pages, sources.value]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    const scroller = scrollerRef.current;
    if (!element || !scroller) return;

    const measure = () => {
      const available = element.clientWidth;
      const columns = Math.max(1, Math.floor((available + GAP) / (MIN_TILE + GAP)));
      const width = (available - GAP * (columns - 1)) / columns;
      // Tile height is the thumbnail plus the page-number row beneath it.
      setMetrics({
        columns,
        width,
        height: width / gridAspect + 28,
        // The scroller also holds the header, so row offsets are relative to this.
        offsetTop: element.offsetTop
      });
      setViewportHeight(scroller.clientHeight);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [gridAspect]);

  const rowHeight = metrics.height + GAP;
  const rowCount = Math.ceil(doc.pages.length / metrics.columns);
  const { first: firstRow, last: lastRow } = windowRows(
    scrollTopRef.current - metrics.offsetTop,
    rowHeight,
    viewportHeight,
    rowCount
  );
  /** What `onScroll` needs to tell whether a new position mounts different rows. */
  const windowRef = useRef({
    firstRow,
    lastRow,
    rowHeight,
    viewportHeight,
    rowCount,
    offsetTop: 0
  });
  windowRef.current = {
    firstRow,
    lastRow,
    rowHeight,
    viewportHeight,
    rowCount,
    offsetTop: metrics.offsetTop
  };
  const firstIndex = firstRow * metrics.columns;
  const visible = doc.pages.slice(firstIndex, lastRow * metrics.columns);
  const tabStop = rovingTabStop(focusIndex, firstIndex, visible.length);

  // Watermark and crop are global signals another tool may have staged — not yet
  // in `doc.pages`, so nothing here shows them without this. Gated on whether
  // anything is actually configured so idle tiles mount no extra overlay at all.
  const showWatermarkPreview = hasWatermarkContent(watermarkSettings.value);

  /**
   * Set when a scroll is about to unmount the tile that has DOM focus. Removing a
   * focused element drops focus to `<body>`, so the next Tab started from the top
   * of the page; the layout effect below hands focus to the new tab stop instead
   * (AUDIT-2026-10-10 UI10).
   */
  const restoreFocusRef = useRef(false);
  /** The column count, for `onScroll`'s stable callback. */
  const metricsRef = useRef(metrics.columns);
  metricsRef.current = metrics.columns;

  const onScroll = useCallback(() => {
    const top = scrollerRef.current?.scrollTop ?? 0;
    scrollTopRef.current = top;
    const w = windowRef.current;
    const next = windowRows(top - w.offsetTop, w.rowHeight, w.viewportHeight, w.rowCount);
    if (next.first !== w.firstRow || next.last !== w.lastRow) {
      const active = document.activeElement;
      const viewport = viewportRef.current;
      if (active instanceof HTMLElement && viewport?.contains(active) && active.dataset.index) {
        const row = Math.floor(Number(active.dataset.index) / Math.max(1, metricsRef.current));
        if (row < next.first || row >= next.last) restoreFocusRef.current = true;
      }
      bumpWindow(n => n + 1);
    }
  }, []);

  const clickPage = (index: number, page: PageRef, event: MouseEvent) => {
    setFocusIndex(index);
    if (!selectable) return;
    if (event.shiftKey && lastClickedRef.current) {
      selectPageRange(doc.id, lastClickedRef.current, page.key);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      togglePageSelection(page.key);
      lastClickedRef.current = page.key;
      return;
    }
    // A plain click replaces the selection, the convention everywhere else.
    setPageSelection(selection.has(page.key) && selection.size === 1 ? [] : [page.key]);
    lastClickedRef.current = page.key;
  };

  /**
   * Scrolls the *scroller* (not the absolutely-sized viewport, which never scrolls)
   * so the row holding `index` is inside the window, and updates `scrollTop` state
   * synchronously so the very next render already mounts that row.
   */
  const revealIndex = useCallback(
    (index: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const row = Math.floor(index / metrics.columns);
      const top = metrics.offsetTop + row * rowHeight;
      const bottom = top + metrics.height;
      const viewTop = scroller.scrollTop;
      const viewBottom = viewTop + scroller.clientHeight;
      let next = viewTop;
      if (top < viewTop) next = top;
      else if (bottom > viewBottom) next = bottom - scroller.clientHeight;
      if (next !== viewTop) {
        scroller.scrollTop = Math.max(0, next);
        scrollTopRef.current = scroller.scrollTop;
        bumpWindow(n => n + 1);
      }
    },
    [metrics.columns, metrics.offsetTop, metrics.height, rowHeight]
  );

  /** Keyboard equivalents for every mouse action (DOC-04, NFR-01). */
  const onKeyDown = (event: KeyboardEvent, index: number, page: PageRef) => {
    const columns = metrics.columns;
    // Under RTL the grid runs right-to-left, so the horizontal arrows swap
    // meaning (AUDIT UI-21). Everything below is written for LTR.
    const key = logicalArrowKey(event.key, isRightToLeft(event.currentTarget as Element));
    const move = (to: number) => {
      const clamped = Math.max(0, Math.min(doc.pages.length - 1, to));
      setFocusIndex(clamped);
      // Focus by index, resolved once the row is rendered — see `pendingFocusRef`.
      pendingFocusRef.current = clamped;
      revealIndex(clamped);
    };

    // Alt+arrow reorders — the accessible alternative to dragging.
    if (
      event.altKey &&
      (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')
    ) {
      event.preventDefault();
      if (refuseEditWhileBusy()) return;
      const keys = selection.has(page.key) ? [...selection] : [page.key];
      const keySet = new Set(keys);
      const indices = doc.pages.flatMap((p, i) => (keySet.has(p.key) ? [i] : []));
      const direction =
        key === 'ArrowLeft'
          ? 'left'
          : key === 'ArrowRight'
            ? 'right'
            : key === 'ArrowUp'
              ? 'up'
              : 'down';
      const target = keyboardMoveTarget(indices, doc.pages.length, direction, columns);
      if (target === null) return;
      movePages(doc.id, keys, target);
      // Keep focus on the page the user moved, wherever it landed.
      const moved = documents.value.find(d => d.id === doc.id)?.pages ?? [];
      const landed = moved.findIndex(p => p.key === page.key);
      if (landed !== -1) move(landed);
      return;
    }

    if (eventMatchesShortcut(event, getEffectiveBinding('rotatePage'))) {
      event.preventDefault();
      if (refuseEditWhileBusy()) return;
      rotatePages(
        doc.id,
        selection.has(page.key) ? selection : [page.key],
        event.shiftKey ? -90 : 90
      );
      return;
    }
    if (eventMatchesShortcut(event, getEffectiveBinding('deletePage'))) {
      event.preventDefault();
      if (refuseEditWhileBusy()) return;
      const before = doc.pages.length;
      deletePages(doc.id, selection.has(page.key) ? selection : [page.key]);
      const after = documents.value.find(d => d.id === doc.id)?.pages.length ?? before;
      // A refused delete (every page selected — RT-3) leaves focus where it
      // was instead of jumping to another tile (regression review R-RT-9).
      if (after < before) move(Math.min(index, after - 1));
      return;
    }
    if (eventMatchesShortcut(event, getEffectiveBinding('selectAll')) && selectable) {
      event.preventDefault();
      selectAllPages(doc.id);
      return;
    }

    switch (key) {
      case 'ArrowRight':
        event.preventDefault();
        move(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        move(index - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        move(index + columns);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(index - columns);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(doc.pages.length - 1);
        break;
      case ' ':
        event.preventDefault();
        if (selectable) {
          if (event.shiftKey && lastClickedRef.current) {
            selectPageRange(doc.id, lastClickedRef.current, page.key);
          } else {
            togglePageSelection(page.key);
            lastClickedRef.current = page.key;
          }
        }
        break;
    }
  };

  useEffect(() => {
    // Keep the roving tabindex in range when pages are removed.
    if (focusIndex > doc.pages.length - 1) setFocusIndex(Math.max(0, doc.pages.length - 1));
  }, [doc.pages.length, focusIndex]);

  // Runs after every render: the first render where the requested row exists in the
  // virtualisation window is the one that gets to focus it. No dependency array on
  // purpose — the row can appear on any subsequent render.
  useLayoutEffect(() => {
    if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      const viewport = viewportRef.current;
      const active = document.activeElement;
      if (viewport && pendingFocusRef.current === null && !(active && viewport.contains(active))) {
        viewport.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
      }
    }
    const want = pendingFocusRef.current;
    if (want === null) return;
    if (want > doc.pages.length - 1) {
      pendingFocusRef.current = null;
      return;
    }
    const el = viewportRef.current?.querySelector<HTMLElement>(`[data-index="${want}"]`);
    if (el) {
      pendingFocusRef.current = null;
      // The scroll was already done by `revealIndex`; don't let focus fight it.
      el.focus({ preventScroll: true });
    }
  });

  /**
   * The cell event handlers, behind one stable ref so `PageCell`'s props stay
   * shallow-equal between renders: a cell whose page, selection, focus and drag
   * state are unchanged is not re-rendered when the window moves.
   */
  const actionsRef = useRef<CellActions>(null as unknown as CellActions);
  actionsRef.current = {
    click: clickPage,
    keyDown: onKeyDown,
    focus: setFocusIndex,
    dragStart: (event, page) => {
      if (activeJob.value !== null) {
        event.preventDefault();
        refuseEditWhileBusy();
        return;
      }
      setDragKey(page.key);
      event.dataTransfer?.setData('text/plain', page.key);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    },
    dragOver: (event, index) => {
      if (!dragKey) return;
      event.preventDefault();
      const tile = event.currentTarget as HTMLElement;
      // Insert before or after depending on which half is hovered —
      // mirrored under RTL, where the page before is to the right.
      setDropIndex(
        dropGapIndex(event.clientX, tile.getBoundingClientRect(), index, isRightToLeft(tile))
      );
    },
    dragEnd: () => {
      setDragKey(null);
      setDropIndex(null);
    },
    drop: event => {
      // Only an internal reorder is this tile's to handle. A file
      // from the OS must reach AppShell's window handler, which
      // skips any drop that is already defaultPrevented.
      if (!dragKey) return;
      event.preventDefault();
      if (dropIndex !== null) {
        const keys = selection.has(dragKey) ? [...selection] : [dragKey];
        movePages(doc.id, keys, dropIndex);
      }
      setDragKey(null);
      setDropIndex(null);
    }
  };

  return (
    <div
      className={styles.scroller}
      ref={scrollerRef}
      onScroll={onScroll}
      data-testid="pagegrid-scroller"
    >
      <div className={styles.header}>
        <h2 className={styles.title}>{doc.name}</h2>
        <span className={styles.count}>
          {tPlural('{count} pages', doc.pages.length)}
          {selection.size > 0 && ` · ${t('{count} selected', { count: selection.size })}`}
        </span>
      </div>

      <div
        className={styles.viewport}
        ref={viewportRef}
        style={{ height: `${Math.max(0, rowCount * rowHeight - GAP)}px` }}
        role="listbox"
        aria-multiselectable={selectable}
        aria-label={t('Pages of {name}', { name: doc.name })}
      >
        <div
          className={styles.window}
          style={{
            transform: `translateY(${firstRow * rowHeight}px)`,
            gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`,
            gridAutoRows: `${metrics.height}px`
          }}
        >
          {visible.map((page, offset) => {
            const index = firstIndex + offset;
            return (
              <PageCell
                key={page.key}
                page={page}
                index={index}
                total={doc.pages.length}
                docId={doc.id}
                isSelected={selection.has(page.key)}
                focusable={index === tabStop}
                dragging={dragKey === page.key}
                dropBefore={dropIndex === index}
                dropAfter={dropIndex === index + 1 && index === doc.pages.length - 1}
                width={metrics.width}
                height={metrics.height}
                aspect={gridAspect}
                selectable={selectable}
                showWatermarkPreview={showWatermarkPreview}
                cropBox={cropBoxes.value[page.key]}
                actions={actionsRef}
              />
            );
          })}
        </div>
      </div>

      <p className={styles.hint}>
        {withSlots(t('Arrow keys move · Space selects · {alt} + arrows reorders · {r} rotates'), {
          alt: <kbd>Alt</kbd>,
          r: <kbd>R</kbd>
        })}
      </p>
    </div>
  );
}

interface CellActions {
  click: (index: number, page: PageRef, event: MouseEvent) => void;
  keyDown: (event: KeyboardEvent, index: number, page: PageRef) => void;
  focus: (index: number) => void;
  dragStart: (event: DragEvent, page: PageRef) => void;
  dragOver: (event: DragEvent, index: number) => void;
  dragEnd: () => void;
  drop: (event: DragEvent) => void;
}

interface PageCellProps {
  page: PageRef;
  index: number;
  total: number;
  docId: string;
  isSelected: boolean;
  /** Holds the grid's single roving tab stop. */
  focusable: boolean;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  width: number;
  height: number;
  aspect: number;
  selectable: boolean;
  showWatermarkPreview: boolean;
  cropBox: CropBox | undefined;
  actions: RefObject<CellActions>;
}

/**
 * One tile of the grid. Memoised: when the window moves by a row, only the cells
 * entering it render; the rest keep their DOM untouched.
 */
const PageCell = memo(function PageCell({
  page,
  index,
  total,
  docId,
  isSelected,
  focusable,
  dragging,
  dropBefore,
  dropAfter,
  width,
  height,
  aspect,
  selectable,
  showWatermarkPreview,
  cropBox,
  actions
}: PageCellProps) {
  const t = useTranslation();
  const act = () => actions.current as CellActions;
  return (
    <div
      data-index={index}
      className={[
        styles.cell,
        dragging ? styles.dragging : '',
        dropBefore ? styles.dropBefore : '',
        dropAfter ? styles.dropAfter : ''
      ]
        .filter(Boolean)
        .join(' ')}
      role="option"
      aria-selected={isSelected}
      aria-label={t(isSelected ? 'Page {n} of {total}, selected' : 'Page {n} of {total}', {
        n: index + 1,
        total
      })}
      // Roving tabindex: one tab stop for the whole grid, arrows within.
      tabIndex={focusable ? 0 : -1}
      draggable
      onClick={event => act().click(index, page, event)}
      onKeyDown={event => act().keyDown(event, index, page)}
      onFocus={() => act().focus(index)}
      onDragStart={event => act().dragStart(event, page)}
      onDragOver={event => act().dragOver(event, index)}
      onDragEnd={() => act().dragEnd()}
      onDrop={event => act().drop(event)}
    >
      <Thumbnail
        page={page}
        docId={docId}
        width={width}
        aspect={aspect}
        isSelected={isSelected}
        selectable={selectable}
        overlay={
          (showWatermarkPreview || cropBox) && (
            <>
              {showWatermarkPreview && (
                <WatermarkOverlay pageIndex={index} width={width} height={height} />
              )}
              {cropBox && <CropBoxPreview box={cropBox} />}
            </>
          )
        }
      />
      <span className={isSelected ? styles.pageNumberSelected : styles.pageNumber}>
        {index + 1}
      </span>
    </div>
  );
});
