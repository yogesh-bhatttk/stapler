/**
 * OPS-10 — the bookmark/outline editor.
 *
 * Rendered as a flat list of rows with visual indentation rather than an ARIA
 * `tree`: every action is a real `<button>` or `<input>`, so the whole editor is
 * reachable and operable with Tab and Enter alone, without a roving-tabindex
 * keyboard model that a `tree` role would oblige us to implement correctly.
 */
import {
  ChevronDown,
  ChevronUp,
  ListIndentDecrease,
  ListIndentIncrease,
  Plus,
  Trash2,
  Wand2
} from 'lucide-preact';
import { activeDoc, activePageIndex } from '../../../core/store';
import { currentDocumentBytes, proposeOutlineFromHeadings } from '../../../core/operations';
import { countCandidates } from '../../../core/outline-detect';
import { confirmAction, notify } from '../../../core/notify';
import { IconButton } from '../../components/IconButton';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useTranslation } from '../../../core/i18n';
import { useJob } from '../../useJob';
import styles from './OutlinePanel.module.css';
import { useDocumentOutline } from './useOutline';
import {
  appendEntry,
  deleteEntry,
  editTree,
  entriesFromHeadingCandidates,
  flattenEntries,
  indentEntry,
  moveEntry,
  newEntry,
  outdentEntry,
  outlineLoading,
  outlineTree,
  outlineUnresolved,
  renameEntry,
  setEntryPage
} from './state';

export function OutlinePanel() {
  const t = useTranslation();
  useDocumentOutline();
  const { run, isRunning } = useJob();

  const doc = activeDoc.value;
  if (!doc) return null;

  const tree = outlineTree.value;
  const rows = flattenEntries(tree);
  const pageNumberOf = (pageKey: string | null) => {
    if (pageKey === null) return null;
    const index = doc.pages.findIndex(page => page.key === pageKey);
    return index < 0 ? null : index + 1;
  };

  const currentIndex = Math.min(Math.max(0, activePageIndex.value), doc.pages.length - 1);
  const currentPage = doc.pages[currentIndex];

  /**
   * OPS-14 — proposes a tree, then hands it to `editTree` exactly like a
   * manual edit: nothing is written to the document by this call. The user
   * still has to review the seeded tree here and export for anything to
   * reach `/Outlines`, same as every other edit in this editor.
   */
  const detectHeadings = () =>
    run({ label: 'Scanning for headings', scope: 'outline.detect' }, async job => {
      if (
        tree.length > 0 &&
        !(await confirmAction({
          title: t('Replace the current outline?'),
          body: t(
            'Detecting headings replaces every bookmark below with what was found. This can be undone with the app’s regular undo.'
          ),
          confirmLabel: t('Replace'),
          tone: 'danger'
        }))
      ) {
        return;
      }
      const bytes = await currentDocumentBytes(job);
      const candidates = await proposeOutlineFromHeadings(bytes, doc.pages.length, job);
      if (candidates.length === 0) {
        notify('info', t('No heading-sized text was found.'), {
          detail: 'Headings are detected by font size standing out from the body text.'
        });
        return;
      }
      const pageKeys = doc.pages.map(page => page.key);
      editTree(() => entriesFromHeadingCandidates(candidates, pageKeys));
      notify('success', t('Found {count} heading(s).', { count: countCandidates(candidates) }), {
        detail: 'Review the outline below, then export to save it.'
      });
    });

  return (
    <div className={styles.panel}>
      <p className={panelStyles.description}>
        {t('Bookmarks are written into the exported PDF. Export to save your changes.')}
      </p>

      <Button
        variant="secondary"
        icon={Plus}
        onClick={() => {
          if (!currentPage) return;
          editTree(current =>
            appendEntry(current, newEntry(`Page ${currentIndex + 1}`, currentPage.key))
          );
        }}
      >
        {t('Add bookmark for page')} {currentIndex + 1}
      </Button>

      <Button variant="secondary" icon={Wand2} onClick={detectHeadings} disabled={isRunning()}>
        {t('Detect headings from font size')}
      </Button>

      {outlineLoading.value && <p className={styles.hint}>{t('Reading bookmarks…')}</p>}

      {!outlineLoading.value && rows.length === 0 && (
        <p className={styles.empty}>{t('This document has no bookmarks yet.')}</p>
      )}

      <ul className={styles.tree} aria-label={t('Bookmarks')}>
        {rows.map(({ entry, depth }) => {
          const pageNumber = pageNumberOf(entry.pageKey);
          return (
            <li
              key={entry.id}
              className={styles.row}
              style={{ marginInlineStart: `calc(var(--space-md) * ${depth})` }}
            >
              <input
                className={styles.title}
                type="text"
                value={entry.title}
                aria-label={`${t('Bookmark title')}, ${t('level')} ${depth + 1}`}
                onInput={event => {
                  const title = (event.target as HTMLInputElement).value;
                  editTree(current => renameEntry(current, entry.id, title));
                }}
              />
              <div className={styles.controls}>
                <span className={styles.page}>
                  {pageNumber === null ? t('No page') : `${t('Page')} ${pageNumber}`}
                </span>
                <Button
                  size="compact"
                  variant="ghost"
                  onClick={() => {
                    if (!currentPage) return;
                    editTree(current => setEntryPage(current, entry.id, currentPage.key));
                  }}
                >
                  {t('Use page')} {currentIndex + 1}
                </Button>
                <IconButton
                  icon={ChevronUp}
                  size="compact"
                  aria-label={`${t('Move up')}: ${entry.title}`}
                  onClick={() => {
                    editTree(current => moveEntry(current, entry.id, 'up'));
                  }}
                />
                <IconButton
                  icon={ChevronDown}
                  size="compact"
                  aria-label={`${t('Move down')}: ${entry.title}`}
                  onClick={() => {
                    editTree(current => moveEntry(current, entry.id, 'down'));
                  }}
                />
                <IconButton
                  icon={ListIndentIncrease}
                  size="compact"
                  aria-label={`${t('Indent')}: ${entry.title}`}
                  onClick={() => {
                    editTree(current => indentEntry(current, entry.id));
                  }}
                />
                <IconButton
                  icon={ListIndentDecrease}
                  size="compact"
                  aria-label={`${t('Outdent')}: ${entry.title}`}
                  onClick={() => {
                    editTree(current => outdentEntry(current, entry.id));
                  }}
                />
                <IconButton
                  icon={Trash2}
                  size="compact"
                  aria-label={`${t('Delete bookmark')}: ${entry.title}`}
                  onClick={() => {
                    editTree(current => deleteEntry(current, entry.id));
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>

      {outlineUnresolved.value > 0 && (
        <p className={styles.warning}>
          {outlineUnresolved.value} {t('bookmark(s) point at a destination Stapler cannot resolve')}
          {' — '}
          {t('a named destination or a non-GoTo action. They export as headings with no page.')}
        </p>
      )}
    </div>
  );
}
