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
import {
  deletePages,
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
import { beginTransaction } from '../../core/history';
import { displayedAspectRatio } from '../../core/rotation';
import { Thumbnail } from '../components/Thumbnail';
import styles from './PageGrid.module.css';

/** Matches the `minmax()` floor below; both must change together. */
const MIN_TILE = 160;
const GAP = 24;
/** Rows kept mounted above and below the viewport, to hide scroll latency. */
const OVERSCAN_ROWS = 2;

export interface PageGridProps {
  doc: StaplerDoc;
  selection: Set<string>;
  selectable: boolean;
}

export function PageGrid({ doc, selection, selectable }: PageGridProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ columns: 1, width: MIN_TILE, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const lastClickedRef = useRef<string | null>(null);

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
      setMetrics({ columns, width, height: width / gridAspect + 28 });
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
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS);
  const lastRow = Math.min(
    rowCount,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS
  );
  const firstIndex = firstRow * metrics.columns;
  const visible = doc.pages.slice(firstIndex, lastRow * metrics.columns);

  const onScroll = useCallback(() => {
    setScrollTop(scrollerRef.current?.scrollTop ?? 0);
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

  /** Keyboard equivalents for every mouse action (DOC-04, NFR-01). */
  const onKeyDown = (event: KeyboardEvent, index: number, page: PageRef) => {
    const columns = metrics.columns;
    const move = (to: number) => {
      const clamped = Math.max(0, Math.min(doc.pages.length - 1, to));
      setFocusIndex(clamped);
      const target = viewportRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`);
      target?.focus();
      target?.scrollIntoView({ block: 'nearest' });
    };

    // Alt+arrow reorders — the accessible alternative to dragging.
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const keys = selection.has(page.key) ? [...selection] : [page.key];
      movePages(doc.id, keys, event.key === 'ArrowLeft' ? index - 1 : index + keys.length + 1);
      move(event.key === 'ArrowLeft' ? index - 1 : index + 1);
      return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      const keys = selection.has(page.key) ? [...selection] : [page.key];
      const delta = event.key === 'ArrowUp' ? -columns : columns;
      movePages(doc.id, keys, index + delta + (delta > 0 ? keys.length : 0));
      move(index + delta);
      return;
    }

    switch (event.key) {
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
      case 'r':
      case 'R':
        event.preventDefault();
        rotatePages(
          doc.id,
          selection.has(page.key) ? selection : [page.key],
          event.shiftKey ? -90 : 90
        );
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        deletePages(doc.id, selection.has(page.key) ? selection : [page.key]);
        move(Math.min(index, doc.pages.length - 2));
        break;
      default:
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && selectable) {
          event.preventDefault();
          selectAllPages(doc.id);
        }
    }
  };

  useEffect(() => {
    // Keep the roving tabindex in range when pages are removed.
    if (focusIndex > doc.pages.length - 1) setFocusIndex(Math.max(0, doc.pages.length - 1));
  }, [doc.pages.length, focusIndex]);

  return (
    <div className={styles.scroller} ref={scrollerRef} onScroll={onScroll}>
      <div className={styles.header}>
        <h2 className={styles.title}>{doc.name}</h2>
        <span className={styles.count}>
          {doc.pages.length} page{doc.pages.length === 1 ? '' : 's'}
          {selection.size > 0 && ` · ${selection.size} selected`}
        </span>
      </div>

      <div
        className={styles.viewport}
        ref={viewportRef}
        style={{ height: `${Math.max(0, rowCount * rowHeight - GAP)}px` }}
        role="listbox"
        aria-multiselectable={selectable}
        aria-label={`Pages of ${doc.name}`}
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
            const isSelected = selection.has(page.key);
            const dropBefore = dropIndex === index;
            const dropAfter = dropIndex === index + 1 && index === doc.pages.length - 1;

            return (
              <div
                key={page.key}
                data-index={index}
                className={[
                  styles.cell,
                  dragKey === page.key ? styles.dragging : '',
                  dropBefore ? styles.dropBefore : '',
                  dropAfter ? styles.dropAfter : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="option"
                aria-selected={isSelected}
                aria-label={`Page ${index + 1} of ${doc.pages.length}${isSelected ? ', selected' : ''}`}
                // Roving tabindex: one tab stop for the whole grid, arrows within.
                tabIndex={index === focusIndex ? 0 : -1}
                draggable
                onClick={event => clickPage(index, page, event)}
                onKeyDown={event => onKeyDown(event, index, page)}
                onFocus={() => setFocusIndex(index)}
                onDragStart={event => {
                  setDragKey(page.key);
                  event.dataTransfer?.setData('text/plain', page.key);
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={event => {
                  if (!dragKey) return;
                  event.preventDefault();
                  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                  // Insert before or after depending on which half is hovered.
                  setDropIndex(event.clientX < rect.left + rect.width / 2 ? index : index + 1);
                }}
                onDragEnd={() => {
                  setDragKey(null);
                  setDropIndex(null);
                }}
                onDrop={event => {
                  event.preventDefault();
                  if (dragKey && dropIndex !== null) {
                    const keys = selection.has(dragKey) ? [...selection] : [dragKey];
                    movePages(doc.id, keys, dropIndex);
                  }
                  setDragKey(null);
                  setDropIndex(null);
                }}
              >
                <Thumbnail
                  page={page}
                  docId={doc.id}
                  width={metrics.width}
                  aspect={gridAspect}
                  isSelected={isSelected}
                  selectable={selectable}
                />
                <span className={isSelected ? styles.pageNumberSelected : styles.pageNumber}>
                  {index + 1}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className={styles.hint}>
        Arrow keys move · Space selects · <kbd>Alt</kbd> + arrows reorders · <kbd>R</kbd> rotates
      </p>
    </div>
  );
}

/** Exported so the transaction helper is used where a drag spans many mutations. */
export function withReorderTransaction<T>(fn: () => T): T {
  const tx = beginTransaction('reorder');
  try {
    return fn();
  } finally {
    tx.end();
  }
}
