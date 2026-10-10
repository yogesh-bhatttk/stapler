import { translate } from '../../core/i18n';
/**
 * DS-06 — the command palette.
 *
 * It previously offered four hard-coded commands, so most tools were unreachable from
 * it despite the acceptance criterion "every tool is reachable from the palette". It
 * now enumerates the registry, matches subsequence-style rather than by substring, and
 * returns focus to where it was opened from.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { useLocation } from 'wouter-preact';
import { Home, Monitor, Moon, Search, Sun } from 'lucide-preact';
import { TOOLS, toolGroupLabel, toolRoute } from '../../core/tools';
import { isCommandPaletteOpen, isShortcutSheetOpen } from '../../core/ui';
import { activeDoc, selectAllPages } from '../../core/store';
import { canRedo, canUndo, redo, undo } from '../../core/history';
import { resolvedTheme, setTheme, themePreference, toggleTheme } from '../theme';
import { fuzzyRank } from '../../core/fuzzy';
import {
  customShortcuts,
  eventMatchesShortcut,
  getEffectiveBinding,
  shortcutLabel
} from '../../core/shortcuts';
import { registerModal } from './Modal';
import { toolIconComponent } from './ToolIcon';
import styles from './CommandPalette.module.css';
import { useTranslation } from '../../core/i18n';

interface Command {
  id: string;
  title: string;
  group: string;
  /** Untranslated title and group, so an English query still matches in any locale. */
  english?: string;
  hint?: string;
  /** True when `hint` is a key chord — hidden on touch screens (GAP-3). */
  hintIsShortcut?: boolean;
  icon: ReturnType<typeof toolIconComponent>;
  run: () => void;
  enabled?: () => boolean;
}

export const CommandPalette = forwardRef<HTMLDivElement, Record<string, never>>(
  function CommandPalette(_props, ref) {
    const t = useTranslation();
    const [location, setLocation] = useLocation();
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const openedFrom = useRef<HTMLElement | null>(null);
    const open = isCommandPaletteOpen.value;

    const commands = useMemo<Command[]>(
      () => [
        ...TOOLS.map(tool => ({
          id: `tool-${tool.id}`,
          title: t(tool.title),
          english: `${tool.title} ${tool.group}`,
          group: t('Tools'),
          hint: t(toolGroupLabel(tool.group)),
          icon: toolIconComponent(tool.icon),
          run: () => setLocation(toolRoute(tool.id))
        })),
        {
          id: 'home',
          title: t('Go home'),
          group: t('Navigate'),
          icon: Home,
          run: () => setLocation('/')
        },
        {
          id: 'select-all',
          title: t('Select all pages'),
          group: t('Document'),
          hint: shortcutLabel('selectAll'),
          hintIsShortcut: true,
          icon: toolIconComponent('LayoutGrid'),
          enabled: () => activeDoc.value !== null,
          run: () => {
            const doc = activeDoc.value;
            if (doc) selectAllPages(doc.id);
          }
        },
        {
          id: 'undo',
          title: t('Undo'),
          group: t('Document'),
          hint: shortcutLabel('undo'),
          hintIsShortcut: true,
          icon: toolIconComponent('Eraser'),
          enabled: canUndo,
          run: undo
        },
        {
          id: 'redo',
          title: t('Redo'),
          group: t('Document'),
          hint: shortcutLabel('redo'),
          hintIsShortcut: true,
          icon: toolIconComponent('Eraser'),
          enabled: canRedo,
          run: redo
        },
        {
          id: 'theme',
          title: t(
            resolvedTheme.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
          ),
          group: t('Settings'),
          icon: resolvedTheme.value === 'dark' ? Sun : Moon,
          run: toggleTheme
        },
        // The way back to following the OS (UI25).
        {
          id: 'theme-system',
          title: t('Use system theme'),
          group: t('Settings'),
          icon: Monitor,
          enabled: () => themePreference.value !== 'system',
          run: () => setTheme('system')
        },
        {
          id: 'shortcuts',
          title: t('Keyboard shortcuts'),
          group: t('Settings'),
          hint: shortcutLabel('shortcuts'),
          hintIsShortcut: true,
          icon: toolIconComponent('FileText'),
          run: () => (isShortcutSheetOpen.value = true)
        }
      ],
      // `customShortcuts` so a remapped binding's hint updates (DS-09, UI19).
      [setLocation, location, resolvedTheme.value, themePreference.value, customShortcuts.value, t]
    );

    const results = useMemo(
      () =>
        fuzzyRank(
          commands.filter(command => command.enabled?.() ?? true),
          query,
          // The group is searchable too, so "document" surfaces everything in it.
          command =>
            command.english
              ? [`${command.title} ${command.group}`, command.english]
              : `${command.title} ${command.group}`
        ),
      [commands, query]
    );

    // `useLayoutEffect`, not a requestAnimationFrame hop: the input exists by the time
    // layout effects run, so focus lands before the first paint. Deferring it by a frame
    // left a window where keystrokes went to the body instead.
    useLayoutEffect(() => {
      if (!open) return;
      openedFrom.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
    }, [open]);

    const close = () => {
      isCommandPaletteOpen.value = false;
      // Esc must land the user back where they were, not on the document body.
      openedFrom.current?.focus?.();
    };

    const execute = (index: number) => {
      const command = results[index];
      if (!command) return;
      close();
      command.run();
    };

    /*
     * Keys are handled on the document rather than on the palette element. Bound to the
     * palette, the handler only fired while focus was inside it, so a stray click on the
     * scrim — or any moment before focus landed — silently dropped Enter and Escape.
     */
    // On the shared dialog stack (UI13): global shortcuts and paste stand down
    // while the palette is open, and a dialog opened over it gets the keys.
    // Layout effect, so the entry exists before the first keystroke can land.
    const stackEntry = useRef<ReturnType<typeof registerModal> | null>(null);
    useLayoutEffect(() => {
      if (!open) return;
      const entry = registerModal();
      stackEntry.current = entry;
      return () => {
        entry.release();
        if (stackEntry.current === entry) stackEntry.current = null;
      };
    }, [open]);

    // Layout effect too: the search field takes focus as the palette mounts, and
    // a plain effect only subscribes after paint — a Tab pressed in between
    // escaped the trap (seen on a fast CI runner).
    useLayoutEffect(() => {
      if (!open) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (stackEntry.current && !stackEntry.current.isTop()) return;
        if (event.key === 'Tab') {
          // The search field is the palette's only focusable control (results
          // are reached with the arrows), so Tab stays on it rather than
          // wandering into the page behind the scrim.
          event.preventDefault();
          inputRef.current?.focus();
          return;
        }
        // The palette shortcut closes it again: the shell's own handler stands
        // down while a dialog is open, so it is answered here.
        if (eventMatchesShortcut(event, getEffectiveBinding('palette'))) {
          event.preventDefault();
          event.stopImmediatePropagation();
          close();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive(index => (results.length === 0 ? 0 : (index + 1) % results.length));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive(index =>
            results.length === 0 ? 0 : (index - 1 + results.length) % results.length
          );
        } else if (event.key === 'Enter') {
          event.preventDefault();
          execute(active);
        }
      };
      // Capture, so the palette answers before the shell's global shortcuts do.
      document.addEventListener('keydown', onKeyDown, true);
      return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [open, active, results]);

    if (!open) return null;

    let lastGroup = '';

    return (
      <div
        ref={ref}
        className={styles.scrim}
        onMouseDown={event => event.target === event.currentTarget && close()}
      >
        <div
          className={styles.palette}
          role="dialog"
          aria-modal="true"
          aria-label={translate('Command palette')}
        >
          <div className={styles.inputRow}>
            <Search size={18} aria-hidden="true" />
            <input
              ref={inputRef}
              className={styles.input}
              placeholder={t('Search tools and actions…')}
              value={query}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-results"
              aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
              onInput={event => {
                setQuery((event.target as HTMLInputElement).value);
                setActive(0);
              }}
            />
          </div>

          <ul className={styles.list} id="palette-results" role="listbox">
            {results.length === 0 && (
              <li className={styles.empty}>{t('Nothing matches “{query}”.', { query })}</li>
            )}
            {results.map((command, index) => {
              const header = command.group !== lastGroup ? command.group : null;
              lastGroup = command.group;
              const Icon = command.icon;
              return (
                <>
                  {header && (
                    <li className={styles.group} role="presentation" key={`group-${header}`}>
                      {header}
                    </li>
                  )}
                  <li
                    key={command.id}
                    id={`palette-${command.id}`}
                    role="option"
                    aria-selected={index === active}
                    // Without this the accessible name concatenates the title and the
                    // group hint, so the row announces as "Merge Organize".
                    aria-label={command.title}
                    className={`${styles.item} ${index === active ? styles.itemActive : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => execute(index)}
                  >
                    <Icon size={16} aria-hidden="true" />
                    {command.title}
                    {command.hint && (
                      <span
                        className={`${styles.itemHint} ${command.hintIsShortcut ? styles.shortcutHint : ''}`}
                      >
                        {command.hint}
                      </span>
                    )}
                  </li>
                </>
              );
            })}
          </ul>
        </div>
      </div>
    );
  }
);
