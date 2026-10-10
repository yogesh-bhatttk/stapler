/**
 * The one way Stapler shows a byte count (audit pattern 6, X-10, IMG-3).
 *
 * Decimal (1000-based) B / KB / MB / GB everywhere — matching `sizeParamBytes`
 * and `targetSizeBytes`, the parsers behind every target-size input and the
 * `?target=` deep link. Those parse "9 MB" as 9,000,000 bytes; a 1024-based
 * display would read the same target back as "8.58 MB" in the very message
 * meant to confirm it.
 *
 * Pure, so `core/` (which must not import from `ui/`) and the UI share it. The
 * number is written the app locale's way ("1,5 MB" in German — AUDIT-2026-10-10
 * UI21); the unit stays the international KB/MB/GB the size inputs use, and the
 * English output is unchanged.
 */
import { currentLocale } from './i18n';

const KB = 1_000;
const MB = 1_000_000;
const GB = 1_000_000_000;

const UNITS = [
  { scale: KB, label: 'KB', decimals: 0 },
  { scale: MB, label: 'MB', decimals: 2 },
  { scale: GB, label: 'GB', decimals: 2 }
] as const;

const numberFormats = new Map<string, Map<number, Intl.NumberFormat>>();

/**
 * An already-rounded decimal string ("1.5", "999") in the app locale's digits
 * and separator. Rounding stays with `toFixed` above, so every locale shows the
 * same figure; grouping is off so "2500 GB" never becomes "2,500 GB".
 */
function localize(fixed: string): string {
  const locale = currentLocale.value;
  if (locale === 'en') return fixed;
  const decimals = fixed.includes('.') ? fixed.length - fixed.indexOf('.') - 1 : 0;
  let byDecimals = numberFormats.get(locale);
  if (!byDecimals) {
    byDecimals = new Map();
    numberFormats.set(locale, byDecimals);
  }
  let format = byDecimals.get(decimals);
  if (!format) {
    try {
      format = new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping: false,
        // Latin digits, like every other number the app interpolates; only the
        // decimal separator follows the locale.
        numberingSystem: 'latn'
      });
    } catch {
      return fixed;
    }
    byDecimals.set(decimals, format);
  }
  return format.format(Number(fixed));
}

/** Drops a trailing ".00"/"0" so "9.00 MB" reads "9 MB" and "1.50 MB" reads "1.5 MB", then localises. */
function trim(fixed: string): string {
  return localize(fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed);
}

/**
 * The unit a size is shown in. The switch points are where the *rounded*
 * figure would reach 1000 of the smaller unit: 999,500 B rounds to "1000 KB",
 * so it is shown as "1 MB" instead.
 */
function unitFor(bytes: number): { scale: number; label: string; decimals: number } {
  if (bytes < KB) return { scale: 1, label: 'B', decimals: 0 };
  if (bytes < MB - KB / 2) return { scale: KB, label: 'KB', decimals: 0 };
  if (bytes < GB - MB / 200) return { scale: MB, label: 'MB', decimals: 2 };
  return { scale: GB, label: 'GB', decimals: 2 };
}

/** `999 B`, `200 KB`, `1.5 MB`, `2.25 GB` — rounded to the nearest. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return `${bytes} B`;
  const { scale, label, decimals } = unitFor(Math.abs(bytes));
  if (scale === 1) return `${localize(String(Math.round(bytes)))} B`;
  return `${trim((bytes / scale).toFixed(decimals))} ${label}`;
}

/** `bytes / scale` rounded *up* at `decimals` places, as text. */
function ceilFixed(bytes: number, scale: number, decimals: number): string {
  const factor = 10 ** decimals;
  // Divide by an integer power of ten last: `bytes * factor / scale` is exact
  // for every byte count this app sees, where `bytes / scale * factor` is not.
  const value = Math.ceil((bytes * factor) / scale) / factor;
  return value.toFixed(decimals);
}

/** `bytes / scale` rounded to the nearest at `decimals` places, as text. */
function roundFixed(bytes: number, scale: number, decimals: number): string {
  const factor = 10 ** decimals;
  return (Math.round((bytes * factor) / scale) / factor).toFixed(decimals);
}

/**
 * Formats a size that is *at least* `bytes`, rounding up — for a result that
 * went over a limit, where rounding to the nearest could make an overshoot
 * read as "at" the limit.
 */
export function formatBytesUp(bytes: number): string {
  if (!Number.isFinite(bytes)) return `${bytes} B`;
  const start = unitFor(bytes);
  if (start.scale === 1) return `${localize(String(Math.ceil(bytes)))} B`;
  // Rounding up can itself reach the next unit (999,001 B → "1000 KB").
  const order = UNITS.findIndex(unit => unit.scale === start.scale);
  for (let i = order; i < UNITS.length; i++) {
    const { scale, label, decimals } = UNITS[i];
    const text = ceilFixed(bytes, scale, decimals);
    if (Number(text) < 1000 || i === UNITS.length - 1) return `${trim(text)} ${label}`;
  }
  return formatBytes(bytes);
}

/**
 * A target and the sizes that missed it, formatted so that every miss reads as
 * strictly larger than the target: the achieved sizes are rounded up, the
 * target to the nearest, and both are shown with as many decimals as it takes
 * for no miss to print the same as the target ("Could not reach 200 KB. The
 * smallest Stapler could make is 200 KB" was IMG-3). At most it falls back to
 * whole bytes, where a larger number is always visibly larger.
 *
 * Sizes at or under the target are formatted normally.
 */
export function formatTargetMisses(
  targetBytes: number,
  achieved: readonly number[]
): { target: string; achieved: string[] } {
  const over = achieved.filter(bytes => bytes > targetBytes);
  const { scale, label } = unitFor(targetBytes);
  if (scale > 1) {
    const maxDecimals = Math.round(Math.log10(scale));
    for (let decimals = label === 'KB' ? 0 : 2; decimals <= maxDecimals; decimals++) {
      const target = roundFixed(targetBytes, scale, decimals);
      const shown = (bytes: number) => ceilFixed(bytes, scale, decimals);
      const distinct = over.every(
        bytes => unitFor(bytes).scale > scale || Number(shown(bytes)) > Number(target)
      );
      if (distinct) {
        return {
          target: `${trim(target)} ${label}`,
          achieved: achieved.map(bytes =>
            bytes <= targetBytes
              ? formatBytes(bytes)
              : unitFor(bytes).scale > scale
                ? formatBytesUp(bytes)
                : `${trim(shown(bytes))} ${label}`
          )
        };
      }
    }
  }
  const exact = (bytes: number) =>
    `${Math.round(bytes).toLocaleString(currentLocale.value === 'en' ? 'en-US' : currentLocale.value)} B`;
  return {
    target: exact(targetBytes),
    achieved: achieved.map(bytes => (bytes > targetBytes ? exact(bytes) : formatBytes(bytes)))
  };
}

/** {@link formatTargetMisses} for one miss. */
export function formatTargetMiss(
  targetBytes: number,
  achievedBytes: number
): { target: string; achieved: string } {
  const { target, achieved } = formatTargetMisses(targetBytes, [achievedBytes]);
  return { target, achieved: achieved[0] };
}

/** Whole decimal megabytes, for messages whose template already says "MB". */
export function wholeMegabytes(bytes: number): number {
  return Math.round(bytes / MB);
}

/** Whole decimal kilobytes, for messages whose template already says "KB". */
export function wholeKilobytes(bytes: number): number {
  return Math.round(bytes / KB);
}
