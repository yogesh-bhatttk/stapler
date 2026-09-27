/**
 * A hover/focus tooltip rendered into `document.body` at a fixed position.
 *
 * `Tooltip` positions its bubble inside the trigger's own box, which a
 * scrolling container clips — the tool rail is one (`overflow-y: auto`, plus a
 * `backdrop-filter` that also traps `position: fixed` descendants), and the
 * top bar's trust chip sits against the viewport edge, where a centred bubble
 * would be cut off. This one escapes both and stays inside the viewport
 * (GAP-3, GAP-7).
 *
 * Same accessibility contract as `Tooltip`: shown on keyboard focus as well as
 * hover, dismissed by Escape (WCAG 1.4.13), and wired with
 * `aria-describedby` only while visible. On a touch screen a tap focuses the
 * control without `:focus-visible`, so no bubble flashes up before navigation.
 */
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import styles from './FloatingTooltip.module.css';

/** Where the bubble sits relative to its anchor, in logical terms. */
export type FloatingSide = 'inline-end' | 'block-end';

const GAP = 8;
const HOVER_DELAY_MS = 300;

export interface TooltipTrigger {
  /** The element the bubble is showing for, or null. */
  anchor: HTMLElement | null;
  hide: () => void;
  /** Spread onto each trigger element. */
  triggerProps: {
    onMouseEnter: (event: MouseEvent) => void;
    onMouseLeave: () => void;
    onFocus: (event: FocusEvent) => void;
    onBlur: () => void;
  };
}

/** One tooltip shared by any number of triggers (every rail item, say). */
export function useTooltipTrigger(): TooltipTrigger {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const hide = () => {
    clearTimeout(timer.current);
    setAnchor(null);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  // Escape dismisses it wherever focus is — including a hover-only bubble.
  useEffect(() => {
    if (!anchor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [anchor]);

  return {
    anchor,
    hide,
    triggerProps: {
      onMouseEnter: event => {
        const target = event.currentTarget as HTMLElement;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setAnchor(target), HOVER_DELAY_MS);
      },
      onMouseLeave: hide,
      onFocus: event => {
        const target = event.currentTarget as HTMLElement;
        // A pointer click or a tap focuses too; only keyboard focus shows it.
        if (!target.matches(':focus-visible')) return;
        clearTimeout(timer.current);
        setAnchor(target);
      },
      onBlur: hide
    }
  };
}

export interface FloatingTooltipProps {
  anchor: HTMLElement | null;
  id: string;
  side: FloatingSide;
  children: ComponentChildren;
}

export function FloatingTooltip({ anchor, id, side, children }: FloatingTooltipProps) {
  if (!anchor || typeof document === 'undefined') return null;
  const rect = anchor.getBoundingClientRect();
  const rtl = getComputedStyle(anchor).direction === 'rtl';
  const viewport = document.documentElement.clientWidth;
  const style: Record<string, string> = {};

  if (side === 'inline-end') {
    style.top = `${rect.top + rect.height / 2}px`;
    style.transform = 'translateY(-50%)';
    if (rtl) style.right = `${viewport - rect.left + GAP}px`;
    else style.left = `${rect.right + GAP}px`;
  } else {
    // Below the anchor, aligned to its inline-end edge — the chip it serves
    // sits at the end of the top bar, so this keeps the bubble on screen.
    style.top = `${rect.bottom + GAP}px`;
    if (rtl) style.left = `${Math.max(GAP, rect.left)}px`;
    else style.right = `${Math.max(GAP, viewport - rect.right)}px`;
  }

  return createPortal(
    <div role="tooltip" id={id} className={styles.bubble} style={style}>
      {children}
    </div>,
    document.body
  );
}
