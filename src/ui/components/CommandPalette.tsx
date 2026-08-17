/**
 * DS-06 — the command palette.
 *
 * It previously offered four hard-coded commands, so most tools were unreachable from
 * it despite the acceptance criterion "every tool is reachable from the palette". It
 * now enumerates the registry, matches subsequence-style rather than by substring, and
 * returns focus to where it was opened from.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { useLocation } from 'wouter-preact';
import { Home, Moon, Search, Sun } from 'lucide-preact';
import { TOOLS, toolRoute } from '../../core/tools';
import { isCommandPaletteOpen, isShortcutSheetOpen } from '../../core/ui';
import { activeDoc, selectAllPages } from '../../core/store';
import { canRedo, canUndo, redo, undo } from '../../core/history';
import { resolvedTheme, toggleTheme } from '../theme';
import { fuzzyRank } from '../../core/fuzzy';
import { toolIconComponent } from './ToolIcon';
import styles from './CommandPalette.module.css';
import { useTranslation } from '../../core/i18n';

interface Command {
  id: string;
  title: string;
  group: string;
  hint?: string;
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
          title: tool.title,
          group: 'Tools',
          hint: tool.group,
          icon: toolIconComponent(tool.icon),
          run: () => setLocation(toolRoute(tool.id))
        })),
        {
          id: 'home',
          title: 'Go home',
          group: 'Navigate',
          icon: Home,
          run: () => setLocation('/')
        },
        {
          id: 'select-all',
          title: 'Select all pages',
          group: 'Document',
          hint: '⌘A',
          icon: toolIconComponent('LayoutGrid'),
          enabled: () => activeDoc.value !== null,
          run: () => {
            const doc = activeDoc.value;
            if (doc) selectAllPages(doc.id);
          }
        },
        {
          id: 'undo',
          title: 'Undo',
          group: 'Document',
          hint: '⌘Z',
          icon: toolIconComponent('Eraser'),
          enabled: canUndo,
          run: undo
        },
        {
          id: 'redo',
          title: 'Redo',
          group: 'Document',
          hint: '⇧⌘Z',
          icon: toolIconComponent('Eraser'),
          enabled: canRedo,
          run: redo
        },
        {
          id: 'theme',
          title: resolvedTheme.value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
          group: 'Settings',
          icon: resolvedTheme.value === 'dark' ? Sun : Moon,
          run: toggleTheme
        },
        {
          id: 'shortcuts',
          title: 'Keyboard shortcuts',
          group: 'Settings',
          hint: '?',
          icon: toolIconComponent('FileText'),
          run: () => (isShortcutSheetOpen.value = true)
        }
      ],
      [setLocation, location, resolvedTheme.value]
    );

    const results = useMemo(
      () =>
        fuzzyRank(
          commands.filter(command => command.enabled?.() ?? true),
          query,
          // The group is searchable too, so "document" surfaces everything in it.
          command => `${command.title} ${command.group}`
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
    useEffect(() => {
      if (!open) return;
      const onKeyDown = (event: KeyboardEvent) => {
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
    });

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
          aria-label="Command palette"
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
              <li className={styles.empty}>
                {t('Nothing matches “')}
                {query}”.
              </li>
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
                    {command.hint && <span className={styles.itemHint}>{command.hint}</span>}
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
