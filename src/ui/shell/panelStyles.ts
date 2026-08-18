/**
 * `OptionsPanel`'s CSS module, re-exported on its own.
 *
 * Every tool panel imports `panelStyles` just for these class names, but
 * `OptionsPanel.tsx` itself statically imports all ~25 tool panel components
 * (its `BODIES` map). Importing `panelStyles` from `OptionsPanel.tsx` directly
 * pulled every one of those panels — and everything they import — into
 * whatever bundle first needed a single CSS class, including the plain
 * landing page (DIST-03: this was the bulk of the ~290KB gz'd chunk the home
 * route had to load before AppShell's lazy `OptionsPanel` chunk was ever
 * needed). This module has nothing else in it, so importing it can't drag
 * anything else along.
 */
import styles from './OptionsPanel.module.css';

export const panelStyles = styles;
