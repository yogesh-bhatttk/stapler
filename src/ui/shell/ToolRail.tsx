import { useTranslation } from '../../core/i18n';
/**
 * The tool rail, driven by the registry in core/tools.ts. Previously every item was
 * hand-written here *and* the same set was re-derived in the options panel, the
 * action bar, and the canvas — so the rail could list a tool the panel had no case
 * for, which is what "Remove Blanks" was.
 */
import { useId, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import {
  findTool,
  groupedTools,
  toolGroupLabel,
  toolRoute,
  type ToolGroup
} from '../../core/tools';
import { ToolIcon } from '../components/ToolIcon';
import { FloatingTooltip, useTooltipTrigger } from '../components/FloatingTooltip';
import tooltipStyles from '../components/FloatingTooltip.module.css';
import styles from './ToolRail.module.css';
import { ChevronDown } from 'lucide-preact';

export function ToolRail() {
  const t = useTranslation();
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState<Set<ToolGroup>>(new Set());
  // GAP-7 — every item names itself on hover *and* keyboard focus, which a
  // `title` attribute never did for focus. One bubble for the whole rail,
  // rendered outside it so the rail's scroll box cannot clip it.
  const tooltip = useTooltipTrigger();
  const tooltipId = useId();
  const tooltipTool = findTool(tooltip.anchor?.dataset.toolId);
  // Tabbing to an item scrolls the rail into view; re-render so the bubble
  // follows its item instead of being dismissed by that scroll.
  const [, setScrollTick] = useState(0);

  const toggleGroup = (group: ToolGroup) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  return (
    <nav
      className={styles.rail}
      aria-label={t('Tools')}
      onScroll={() => tooltip.anchor && setScrollTick(n => n + 1)}
    >
      {groupedTools().map(({ group, tools }) => {
        const isCollapsed = collapsed.has(group);
        const groupId = `rail-group-${group}`;
        const labelId = `rail-group-label-${group}`;
        return (
          // A named group, so the icon-only rail (< 800px), where the heading
          // is hidden, still announces "Organize", "Convert"… as the home page
          // shows them; a hairline separates the groups visually there.
          <div className={styles.railGroup} key={group} role="group" aria-labelledby={labelId}>
            <button
              type="button"
              className={styles.railHeading}
              onClick={() => toggleGroup(group)}
              aria-expanded={!isCollapsed}
              aria-controls={groupId}
            >
              <span id={labelId}>{t(toolGroupLabel(group))}</span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`${styles.railHeadingChevron} ${isCollapsed ? styles.railHeadingChevronCollapsed : ''}`}
              />
            </button>
            <ul className={styles.railList} id={groupId} hidden={isCollapsed}>
              {tools.map(tool => {
                const href = toolRoute(tool.id);
                const active =
                  location === href ||
                  location.startsWith(href + '?') ||
                  location.startsWith(href + '/');
                return (
                  <li key={tool.id}>
                    <a
                      href={`#${href}`}
                      className={`${styles.railItem} ${active ? styles.active : ''}`}
                      // Under 800px the label is visually hidden but still in
                      // the accessibility tree, so it stays the accessible name.
                      data-tool-id={tool.id}
                      aria-current={active ? 'page' : undefined}
                      aria-describedby={
                        tooltip.anchor?.dataset.toolId === tool.id
                          ? `${tooltipId}-summary`
                          : undefined
                      }
                      {...tooltip.triggerProps}
                    >
                      <ToolIcon name={tool.icon} />
                      <span className={styles.railLabel}>{t(tool.title)}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {tooltipTool && (
        <FloatingTooltip anchor={tooltip.anchor} id={tooltipId} side="inline-end">
          <span className={tooltipStyles.title}>{t(tooltipTool.title)}</span>
          <span id={`${tooltipId}-summary`}>{t(tooltipTool.summary)}</span>
        </FloatingTooltip>
      )}
    </nav>
  );
}
