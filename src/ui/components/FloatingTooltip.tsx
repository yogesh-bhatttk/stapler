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
 *
 * UI-11 — WCAG 1.4.13 also asks that the bubble be *hoverable*: moving the
 * pointer from the trigger onto the bubble (to read a long summary, or with a
 * screen magnifier) must not dismiss it. Leaving the trigger now hides it
 * after a short delay, and the bubble accepts the pointer and keeps itself
 * open while hovered. The bubble learns which trigger hook owns it through
 * {@link hoverKeepers}, so callers wire nothing extra.
 */
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import styles from './FloatingTooltip.module.css';

/** Where the bubble sits relative to its anchor, in logical terms. */
export type FloatingSide = 'inline-end' | 'block-end';

const GAP = 8;
const HOVER_DELAY_MS = 300;
/** UI-11 — long enough to cross the {@link GAP} between trigger and bubble. */
export const HIDE_DELAY_MS = 200;

/** What a bubble calls while the pointer is over it, per anchor element. */
interface HoverKeeper {
  /** The pointer is on the bubble: stay open. */
  keep: () => void;
  /** The pointer left the bubble: hide after the delay. */
  release: () => void;
}
const hoverKeepers = new WeakMap<HTMLElement, HoverKeeper>();

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
  const hideSoon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAnchor(null), HIDE_DELAY_MS);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  // UI-11 — let the bubble for this anchor keep it open while hovered.
  useEffect(() => {
    if (!anchor) return;
    hoverKeepers.set(anchor, { keep: () => clearTimeout(timer.current), release: hideSoon });
    return () => {
      hoverKeepers.delete(anchor);
    };
  }, [anchor]);

  // Escape dismisses it wherever focus is — including a hover-only bubble.
  // A layout effect, so the listener is attached in the same commit that
  // shows the bubble: an Escape pressed the moment it appears is never missed.
  useLayoutEffect(() => {
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
        // Already showing for this trigger (the pointer came back from the
        // bubble): just stay; otherwise show after the hover delay.
        if (anchor === target) return;
        timer.current = setTimeout(() => setAnchor(target), HOVER_DELAY_MS);
      },
      // Not at once: the pointer may be on its way to the bubble (UI-11).
      onMouseLeave: () => {
        if (anchor) hideSoon();
        else clearTimeout(timer.current);
      },
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

  // Looked up on each event, not now: the hook registers its keeper in an
  // effect, after this first render.
  return createPortal(
    <div
      role="tooltip"
      id={id}
      className={styles.bubble}
      style={style}
      onMouseEnter={() => hoverKeepers.get(anchor)?.keep()}
      onMouseLeave={() => hoverKeepers.get(anchor)?.release()}
    >
      {children}
    </div>,
    document.body
  );
}
