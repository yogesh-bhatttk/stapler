/**
 * Checks the web twin runs before it boots (web build only; the extension page
 * can't be framed by a site, and its manifest already declares the browser floor).
 *
 * - Clickjacking (AUDIT-2026-10-10 S-info): `frame-ancestors` can't be set from
 *   the `<meta>` CSP the static site ships, so a hostile page could frame the
 *   editor and overlay its buttons. Framed, the app refuses to render and offers
 *   a link to open Stapler on its own.
 * - Browser floor (QA-floor): pdf.js calls newer ES built-ins with no feature
 *   test, so an old browser loaded the app fine and then failed on the first
 *   PDF. The built-ins are checked up front and an "update your browser" message
 *   is shown instead. The list mirrors `scripts/browser-floors.mjs`'s
 *   `REQUIRED_APIS`; `tests/unit/audit-2026-10-10-ui.test.ts` fails if the
 *   two drift apart.
 */
import { render } from 'preact';
import { translate } from '../core/i18n';
import { EmptyState } from './components/Feedback';

/** Each built-in the shipped pdf.js calls unguarded, by its `REQUIRED_APIS` name. */
export const REQUIRED_BUILT_INS: ReadonlyArray<{
  api: string;
  present: (g: typeof globalThis) => boolean;
}> = [
  {
    api: 'Math.sumPrecise',
    present: g => typeof (g.Math as { sumPrecise?: unknown }).sumPrecise === 'function'
  },
  {
    api: 'Map.prototype.getOrInsertComputed',
    present: g =>
      typeof (g.Map.prototype as { getOrInsertComputed?: unknown }).getOrInsertComputed ===
      'function'
  },
  {
    api: 'Uint8Array.fromBase64',
    present: g => typeof (g.Uint8Array as { fromBase64?: unknown }).fromBase64 === 'function'
  },
  { api: 'Promise.try', present: g => typeof (g.Promise as { try?: unknown }).try === 'function' },
  { api: 'URL.parse', present: g => typeof (g.URL as { parse?: unknown }).parse === 'function' },
  {
    api: 'Promise.withResolvers',
    present: g => typeof (g.Promise as { withResolvers?: unknown }).withResolvers === 'function'
  }
];

/** The required built-ins this realm lacks, by name. */
export function missingBuiltIns(g: typeof globalThis = globalThis): string[] {
  return REQUIRED_BUILT_INS.filter(entry => {
    try {
      return !entry.present(g);
    } catch {
      return true;
    }
  }).map(entry => entry.api);
}

/** True when this window is inside a frame — including a cross-origin one, whose `top` throws. */
export function isFramed(win: Pick<Window, 'top' | 'self'>): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

export type BootBlock = { kind: 'framed' } | { kind: 'old-browser'; missing: string[] };

/** Why the web twin must not boot here, or null. */
export function bootBlock(win: Window & typeof globalThis): BootBlock | null {
  if (isFramed(win)) return { kind: 'framed' };
  const missing = missingBuiltIns(win);
  if (missing.length > 0) return { kind: 'old-browser', missing };
  return null;
}

function BootBlocked({ block, href }: { block: BootBlock; href: string }) {
  if (block.kind === 'framed') {
    return (
      <EmptyState
        title={translate('Stapler can’t run inside another page')}
        body={translate(
          'For your safety Stapler only works in its own tab, where no other site can cover or watch its controls.'
        )}
        action={
          <a href={href} target="_blank" rel="noopener noreferrer">
            {translate('Open Stapler directly')}
          </a>
        }
      />
    );
  }
  return (
    <EmptyState
      title={translate('Your browser is too old for Stapler')}
      body={translate(
        'Please update your browser to the latest version. Stapler needs features it does not have yet: {features}.',
        { features: block.missing.join(', ') }
      )}
    />
  );
}

/**
 * Renders the explanation in place of the app and returns true when the web
 * twin must not boot; returns false (rendering nothing) when it may.
 */
export function renderBootBlock(root: HTMLElement, win: Window & typeof globalThis): boolean {
  const block = bootBlock(win);
  if (!block) return false;
  render(<BootBlocked block={block} href={win.location.href} />, root);
  return true;
}
