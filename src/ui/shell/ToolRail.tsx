import { translate } from '../../core/i18n';
/**
 * The tool rail, driven by the registry in core/tools.ts. Previously every item was
 * hand-written here *and* the same set was re-derived in the options panel, the
 * action bar, and the canvas — so the rail could list a tool the panel had no case
 * for, which is what "Remove Blanks" was.
 */
import { useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { groupedTools, toolRoute, type ToolGroup } from '../../core/tools';
import { ToolIcon } from '../components/ToolIcon';
import styles from './ToolRail.module.css';
import { ChevronDown } from 'lucide-preact';

export function ToolRail() {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState<Set<ToolGroup>>(new Set());

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
    <nav className={styles.rail} aria-label={translate('Tools')}>
      {groupedTools().map(({ group, tools }) => {
        const isCollapsed = collapsed.has(group);
        const groupId = `rail-group-${group}`;
        return (
          <div className={styles.railGroup} key={group}>
            <button
              type="button"
              className={styles.railHeading}
              onClick={() => toggleGroup(group)}
              aria-expanded={!isCollapsed}
              aria-controls={groupId}
            >
              <span>{group}</span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`${styles.railHeadingChevron} ${isCollapsed ? styles.railHeadingChevronCollapsed : ''}`}
              />
            </button>
            <ul className={styles.railList} id={groupId} hidden={isCollapsed}>
              {tools.map(tool => {
                const href = toolRoute(tool.id);
                const active = location === href;
                return (
                  <li key={tool.id}>
                    <a
                      href={`#${href}`}
                      className={`${styles.railItem} ${active ? styles.active : ''}`}
                      // The rail collapses to icons under 800px, where the label is
                      // hidden — so the accessible name comes from the title, not
                      // from the visually-hidden text.
                      title={tool.title}
                      aria-current={active ? 'page' : undefined}
                    >
                      <ToolIcon name={tool.icon} />
                      <span className={styles.railLabel}>{tool.title}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
