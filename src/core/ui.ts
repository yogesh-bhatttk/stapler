/**
 * Cross-cutting UI state that is not tool-specific.
 *
 * Tool settings used to live here too; they now sit beside their panels under
 * `src/ui/tools`, so core carries no knowledge of individual tools.
 */
import { signal } from '@preact/signals';

export const isCommandPaletteOpen = signal(false);
export const isShortcutSheetOpen = signal(false);
