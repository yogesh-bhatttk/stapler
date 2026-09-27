/**
 * GAP-3 — the phone-width replacement for the tool rail: a searchable,
 * grouped list of every tool in a bottom sheet, opened from the top bar's
 * Tools button below 600px.
 *
 * Built on `Modal` (placement "sheet"), so it joins the modal stack: focus
 * moves in and is trapped, Escape closes only the topmost dialog, global
 * shortcuts stand down while it is open, and focus returns to the Tools
 * button afterwards. The grouping and search are the home launcher's own
 * (`searchToolGroups`), so the two never disagree.
 */
import { useMemo, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { useTranslation } from '../../core/i18n';
import { toolRoute } from '../../core/tools';
import { Modal } from '../components/Modal';
import { Field, TextInput } from '../components/Field';
import { ToolIcon } from '../components/ToolIcon';
import { searchToolGroups } from '../toolSearch';
import styles from './ToolsSheet.module.css';

export function ToolsSheet({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  const [location, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const sections = useMemo(() => searchToolGroups(query, t), [query, t]);

  return (
    <Modal title={t('Tools')} onClose={onClose} placement="sheet">
      <div className={styles.content}>
        <Field label={t('Search tools')}>
          {id => (
            <TextInput
              id={id}
              type="search"
              value={query}
              placeholder={t('merge, compress, redact…')}
              onInput={event => setQuery((event.target as HTMLInputElement).value)}
              onKeyDown={event => {
                // Enter opens the best match, as in the command palette.
                const first = sections[0]?.tools[0];
                if (event.key === 'Enter' && first) {
                  event.preventDefault();
                  onClose();
                  setLocation(toolRoute(first.id));
                }
              }}
            />
          )}
        </Field>

        {sections.length === 0 && (
          <p className={styles.empty} role="status">
            {t('No tool matches “{query}”.', { query })}
          </p>
        )}

        {sections.map(section => {
          const headingId = `tools-sheet-${section.group}`;
          return (
            <section key={section.group} className={styles.section} aria-labelledby={headingId}>
              <h3 className={styles.heading} id={headingId}>
                {section.label}
              </h3>
              <ul className={styles.list}>
                {section.tools.map(tool => {
                  const href = toolRoute(tool.id);
                  const active =
                    location === href ||
                    location.startsWith(href + '?') ||
                    location.startsWith(href + '/');
                  return (
                    <li key={tool.id}>
                      <a
                        className={`${styles.tool} ${active ? styles.active : ''}`}
                        href={`#${href}`}
                        aria-current={active ? 'page' : undefined}
                        onClick={onClose}
                      >
                        <ToolIcon name={tool.icon} size={18} />
                        <span className={styles.toolBody}>
                          <span className={styles.toolTitle}>{t(tool.title)}</span>
                          <span className={styles.toolSummary}>{t(tool.summary)}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
