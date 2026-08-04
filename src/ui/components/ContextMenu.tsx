/**
 * A positioned menu (right-click or a "…" trigger). Follows the WAI-ARIA menu
 * pattern: roving tabindex, arrow keys move focus, Escape closes and restores
 * focus to whatever opened it — the same restore idea as `Modal`, since a menu
 * is a transient dialog in every way that matters for keyboard users.
 */
import type { LucideIcon } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import styles from './ContextMenu.module.css';

export interface ContextMenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  items: readonly ContextMenuItem[];
  /** Viewport coordinates of the point that opened the menu. */
  x: number;
  y: number;
  onClose: () => void;
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [position, setPosition] = useState({ x, y });

  const enabled = items.map((item, index) => ({ item, index })).filter(e => !e.item.disabled);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const clampedX = Math.min(x, window.innerWidth - rect.width - 4);
    const clampedY = Math.min(y, window.innerHeight - rect.height - 4);
    setPosition({ x: Math.max(4, clampedX), y: Math.max(4, clampedY) });
  }, [x, y]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const firstEnabled = enabled[0]?.index ?? 0;
    setFocusIndex(firstEnabled);
    menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[firstEnabled]?.focus();

    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      previouslyFocused?.focus?.();
    };
    // Deliberately runs once, on mount/unmount only: `enabled` and `onClose` are
    // recomputed every render, and re-subscribing on every focus-index change
    // would fight the roving tabindex below for control of DOM focus.
  }, []);

  const focusAt = (index: number) => {
    setFocusIndex(index);
    menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus();
  };

  const step = (from: number, delta: number) => {
    if (enabled.length === 0) return;
    const currentPos = enabled.findIndex(e => e.index === from);
    const nextPos = (currentPos + delta + enabled.length) % enabled.length;
    focusAt(enabled[nextPos].index);
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      className={styles.menu}
      style={{ left: position.x, top: position.y }}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          step(focusIndex, 1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          step(focusIndex, -1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          if (enabled[0]) focusAt(enabled[0].index);
        } else if (event.key === 'End') {
          event.preventDefault();
          if (enabled.length > 0) focusAt(enabled[enabled.length - 1].index);
        }
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={index === focusIndex ? 0 : -1}
          disabled={item.disabled}
          className={`${styles.item} ${item.danger ? styles.danger : ''}`}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.icon && <Icon icon={item.icon} size={15} />}
          {item.label}
        </button>
      ))}
    </div>
  );
}
