/**
 * DS-08 — the shortcut sheet, opened with `?`.
 *
 * The previous sheet advertised "Delete Selected Pages — Backspace/Del" when no such
 * handler existed anywhere in the app. Every row below maps to a real binding; the
 * modifier symbol follows the platform.
 */
import { Keyboard } from 'lucide-preact';
import { forwardRef } from 'preact/compat';
import { Modal } from './Modal';
import styles from './InfoModals.module.css';
import { useTranslation } from '../../core/i18n';
import { getEffectiveBinding, formatBinding, customShortcuts } from '../../core/shortcuts';

const IS_APPLE = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent);
const MOD = IS_APPLE ? '⌘' : 'Ctrl';
const ALT = IS_APPLE ? '⌥' : 'Alt';

export const ShortcutModal = forwardRef<HTMLDivElement, { onClose: () => void }>(
  function ShortcutModal({ onClose }, ref) {
    const t = useTranslation();
    // Access signal to re-render on changes
    void customShortcuts.value;

    const groups = [
      {
        title: t('Global'),
        rows: [
          [t('Command palette'), formatBinding(getEffectiveBinding('palette')) || `${MOD} K`],
          [t('Keyboard shortcuts'), formatBinding(getEffectiveBinding('shortcuts')) || '?'],
          [t('Switch theme'), t('From the palette')]
        ]
      },
      {
        title: t('Document'),
        rows: [
          [t('Undo'), formatBinding(getEffectiveBinding('undo')) || `${MOD} Z`],
          [
            t('Redo'),
            formatBinding(getEffectiveBinding('redo')) || `${IS_APPLE ? '⇧⌘Z' : 'Ctrl Y'}`
          ],
          [t('Select all pages'), formatBinding(getEffectiveBinding('selectAll')) || `${MOD} A`]
        ]
      },
      {
        title: t('Page grid'),
        rows: [
          [t('Move focus'), '← → ↑ ↓'],
          [t('First / last page'), 'Home / End'],
          [t('Select focused page'), 'Space'],
          [t('Extend selection'), 'Shift Space'],
          [t('Reorder page'), t('{alt} + arrows', { alt: ALT })],
          [t('Rotate page'), formatBinding(getEffectiveBinding('rotatePage')) || 'R'],
          [t('Delete page'), formatBinding(getEffectiveBinding('deletePage')) || 'Delete']
        ]
      },
      {
        title: t('Stamps and regions'),
        rows: [
          [t('Nudge a stamp'), t('Arrow keys')],
          [t('Nudge further'), t('Shift + arrows')],
          [t('Remove a stamp'), 'Delete'],
          [t('Move a scan corner'), t('Arrow keys on the handle')]
        ]
      }
    ];

    return (
      <Modal
        ref={ref}
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
);
