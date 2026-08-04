/**
 * A tab list only — the panels are the caller's concern. Follows the WAI-ARIA
 * tabs pattern: roving tabindex, arrow keys move focus and activate immediately.
 */
import styles from './Tabs.module.css';

export interface TabItem {
  id: string;
  label: string;
}

export interface TabsProps {
  items: readonly TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel: string;
}

export function Tabs({ items, activeId, onChange, ariaLabel }: TabsProps) {
  const move = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    onChange(items[next].id);
    // Move focus with selection so the roving tabindex stays consistent with
    // where the browser actually is — arrow keys should never leave a tab
    // focused that reads as unselected.
    const el = document.getElementById(`tab-${items[next].id}`);
    el?.focus();
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className={styles.tablist}>
      {items.map((item, index) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            id={`tab-${item.id}`}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            className={`${styles.tab} ${active ? styles.active : ''}`}
            onClick={() => onChange(item.id)}
            onKeyDown={event => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(index, -1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                move(index, -index);
              } else if (event.key === 'End') {
                event.preventDefault();
                move(index, items.length - 1 - index);
              }
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
