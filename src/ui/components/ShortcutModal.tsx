/**
 * DS-08 — the shortcut sheet, opened with `?`.
 *
 * The previous sheet advertised "Delete Selected Pages — Backspace/Del" when no such
 * handler existed anywhere in the app. Every row below maps to a real binding; the
 * modifier symbol follows the platform.
 */
import { Keyboard } from 'lucide-preact';
import { Modal } from './Modal';
import styles from './InfoModals.module.css';
import { useTranslation } from '../../core/i18n';
import { getEffectiveBinding, formatBinding, customShortcuts } from '../../core/shortcuts';

const IS_APPLE = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent);
const MOD = IS_APPLE ? '⌘' : 'Ctrl';
const ALT = IS_APPLE ? '⌥' : 'Alt';

export function ShortcutModal({ onClose }: { onClose: () => void }) {
  const t = useTranslation();
  // Access signal to re-render on changes
  void customShortcuts.value;

  const groups = [
    {
      title: 'Global',
      rows: [
        ['Command palette', formatBinding(getEffectiveBinding('palette')) || `${MOD} K`],
        ['Keyboard shortcuts', formatBinding(getEffectiveBinding('shortcuts')) || '?'],
        ['Switch theme', 'From the palette']
      ]
    },
    {
      title: 'Document',
      rows: [
        ['Undo', formatBinding(getEffectiveBinding('undo')) || `${MOD} Z`],
        ['Redo', formatBinding(getEffectiveBinding('redo')) || `${IS_APPLE ? '⇧⌘Z' : 'Ctrl Y'}`],
        ['Select all pages', formatBinding(getEffectiveBinding('selectAll')) || `${MOD} A`]
      ]
    },
    {
      title: 'Page grid',
      rows: [
        ['Move focus', '← → ↑ ↓'],
        ['First / last page', 'Home / End'],
        ['Select focused page', 'Space'],
        ['Extend selection', 'Shift Space'],
        ['Reorder page', `${ALT} + arrows`],
        ['Rotate page', formatBinding(getEffectiveBinding('rotatePage')) || 'R'],
        ['Delete page', formatBinding(getEffectiveBinding('deletePage')) || 'Delete']
      ]
    },
    {
      title: 'Stamps and regions',
      rows: [
        ['Nudge a stamp', 'Arrow keys'],
        ['Nudge further', 'Shift + arrows'],
        ['Remove a stamp', 'Delete'],
        ['Move a scan corner', 'Arrow keys on the handle']
      ]
    }
  ];

  return (
    <Modal
      title={t('Keyboard shortcuts')}
      icon={<Keyboard size={20} aria-hidden="true" />}
      onClose={onClose}
      size="lg"
    >
      <div className={styles.columns}>
        {groups.map(group => (
          <div key={group.title}>
            <h3 className={styles.groupTitle}>{group.title}</h3>
            <ul className={styles.rows}>
              {group.rows.map(([label, keys]) => (
                <li className={styles.row} key={label}>
                  <span>{label}</span>
                  <kbd className={styles.keys}>{keys}</kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}
