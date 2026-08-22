import { signal } from '@preact/signals';

/** ANN-07 — the second document, chosen the same way ANN-02's compare tool picks one. */
export const sideBySideSourceId = signal<string | null>(null);

/** Shared across both panes — this is the "kept in sync" state the AC asks for. */
export const sideBySidePageIndex = signal(0);
export const sideBySideZoomStep = signal(2); // index into ZOOM_STEPS, 100%
