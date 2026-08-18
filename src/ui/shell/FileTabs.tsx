import { translate } from '../../core/i18n';
/**
 * `FileTabs` from DESIGN-ADAPTATION §4.2 / §5. It was specified in the layout and
 * listed as a component to build, but never existed — so a multi-document workspace
 * had no way to switch documents, and DOC-01's per-document tabs were unreachable.
 */
import { X } from 'lucide-preact';
import { activeDocId, closeDocument, documents } from '../../core/store';
import { confirmAction } from '../../core/notify';
import styles from './TopBar.module.css';

export function FileTabs() {
  const docs = documents.value;
  if (docs.length === 0) return null;

  const close = async (id: string, name: string, dirty: boolean) => {
    if (
      dirty &&
      !(await confirmAction({
        title: `Close ${name}?`,
        body: 'It has unsaved changes. Closing discards them — the original file on disk is untouched.',
        confirmLabel: 'Discard changes',
        tone: 'danger'
      }))
    ) {
      return;
    }
    closeDocument(id);
  };

  return (
    // Not a full ARIA `tablist` pattern (no roving-tabindex arrow-key
    // navigation, no linked `tabpanel`) and each tab carries a close control
    // a `tablist`'s required-children rule forbids as a sibling of `tab` — so
    // this is a plain labelled group of buttons, with `aria-current` marking
    // the active document instead of `aria-selected`.
    <div className={styles.tabs} aria-label={translate('Open documents')}>
      {docs.map(doc => {
        const active = doc.id === activeDocId.value;
        return (
          <div
            key={doc.id}
            className={`${styles.tab} ${active ? styles.tabActive : ''}`}
            title={doc.name}
          >
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              className={styles.tabTrigger}
              onClick={() => (activeDocId.value = doc.id)}
            >
              {doc.dirty && (
                <span className={styles.dirtyDot} aria-label={translate('Unsaved changes')} />
              )}
              <span className={styles.tabName}>{doc.name}</span>
            </button>
            <span
              // A nested <button> is invalid HTML, so the close affordance is a
              // span with its own keyboard handling.
              role="button"
              tabIndex={0}
              aria-label={`Close ${doc.name}`}
              onClick={event => {
                event.stopPropagation();
                void close(doc.id, doc.name, doc.dirty);
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                void close(doc.id, doc.name, doc.dirty);
              }}
            >
              <X size={12} aria-hidden="true" />
            </span>
          </div>
        );
      })}
    </div>
  );
}
