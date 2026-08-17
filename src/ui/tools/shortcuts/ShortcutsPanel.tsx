/**
 * DS-09 — Shortcuts panel for customizing keyboard shortcuts.
 */
import { useState, useEffect } from 'preact/hooks';
import { RotateCcw } from 'lucide-preact';
import {
  SHORTCUT_DEFINITIONS,
  getEffectiveBinding,
  formatBinding,
  setShortcutOverride,
  resetShortcuts,
  customShortcuts,
  type ShortcutBinding
} from '../../../core/shortcuts';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/OptionsPanel';
import { notify } from '../../../core/notify';
import { useTranslation } from '../../../core/i18n';

export function ShortcutsPanel() {
  const t = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [conflictMsg, setConflictMsg] = useState<string | null>(null);

  // Subscribe to changes in customShortcuts
  void customShortcuts.value;

  useEffect(() => {
    if (!editingId) return;

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Ignore modifier-only presses
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

      if (e.key === 'Escape') {
        setEditingId(null);
        setConflictMsg(null);
        return;
      }

      const binding: ShortcutBinding = {
        key: e.key.toLowerCase(),
        mod: e.metaKey || e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey
      };

      const result = setShortcutOverride(editingId, binding);
      if (result.success) {
        setEditingId(null);
        setConflictMsg(null);
        notify('success', t('Shortcut updated'));
      } else if (result.conflict) {
        setConflictMsg(
          `${t('Conflict with')} "${result.conflict.label}". ${t('Choose another key.')}`
        );
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [editingId, t]);

  const handleReset = () => {
    resetShortcuts();
    setEditingId(null);
    setConflictMsg(null);
    notify('info', t('Shortcuts reset to defaults'));
  };

  return (
    <>
      <div className={panelStyles.section}>
        <p style={{ margin: '0 0 12px', fontSize: '0.875em', opacity: 0.8 }}>
          {t('Click a shortcut row to record a new key combination.')}
        </p>

        {conflictMsg && (
          <div
            style={{
              padding: '8px 12px',
              marginBottom: '12px',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--danger-bg)',
              color: 'var(--danger)',
              fontSize: '0.85em'
            }}
          >
            {conflictMsg}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {SHORTCUT_DEFINITIONS.map(def => {
            const binding = getEffectiveBinding(def.id);
            const isEditing = editingId === def.id;

            return (
              <button
                key={def.id}
                type="button"
                onClick={() => {
                  setConflictMsg(null);
                  setEditingId(isEditing ? null : def.id);
                }}
                aria-pressed={isEditing}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 12px',
                  borderRadius: 'var(--radius-md)',
                  border: isEditing ? '2px solid var(--primary)' : '1px solid var(--hairline)',
                  cursor: 'pointer',
                  background: isEditing ? 'var(--surface-2)' : 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  textAlign: 'left',
                  width: '100%'
                }}
                data-testid={`shortcut-row-${def.id}`}
              >
                <div>
                  <div style={{ fontWeight: 500, fontSize: '0.9em' }}>{def.label}</div>
                  <div style={{ fontSize: '0.75em', opacity: 0.6 }}>{def.category}</div>
                </div>
                <kbd
                  style={{
                    padding: '2px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--surface-3)',
                    fontSize: '0.85em',
                    fontFamily: 'var(--font-mono)'
                  }}
                >
                  {isEditing ? t('Press key...') : formatBinding(binding)}
                </kbd>
              </button>
            );
          })}
        </div>
      </div>

      <div className={panelStyles.section}>
        <Button onClick={handleReset} variant="secondary" icon={RotateCcw}>
          {t('Reset to defaults')}
        </Button>
      </div>
    </>
  );
}
