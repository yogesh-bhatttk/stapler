/**
 * The boundary between a stored recipe and the batch runner (AUDIT-2026-10-01 X-15).
 *
 * A recipe's `tools` and `settings` come back from IndexedDB — written by this
 * build, by an older one, or imported from a JSON file someone handed over — so
 * `core/db.ts` types them as `unknown`. Before the runner hands a slice to the
 * worker, it goes through `parseRecipe`, which either returns settings in each
 * tool's own type or the list of fields that are wrong. A malformed recipe then
 * stops the run with a message, instead of crashing a worker halfway through a
 * folder or stamping a page with `NaN`-sized text.
 *
 * Compatibility with what older builds stored:
 *  - a slice that is missing, `undefined` or `null` means "this recipe does not
 *    configure that tool" (early builds stored `null` for untouched settings);
 *  - top-level keys this build does not know are ignored, and so are unknown
 *    fields inside a slice — only the fields each tool reads are copied out;
 *  - every field of each settings type predates recipes, so a missing field is
 *    a malformed recipe, not an old one, and is reported rather than defaulted.
 */
import type { CompressSettings } from '../compress/state';
import type {
  HeaderFooterAlign,
  HeaderFooterSettings,
  WatermarkImage,
  WatermarkPosition,
  WatermarkSettings
} from '../watermark/state';
import type { NUpLayout, NUpSettings } from '../nup/state';
import type { NormalizeSettings, PaperSize, ScaleMode } from '../normalize/state';

/** The settings a recipe can carry, one optional slice per tool. */
export interface RecipeSettings {
  compress?: CompressSettings;
  watermark?: WatermarkSettings;
  headerFooter?: HeaderFooterSettings;
  nup?: NUpSettings;
  normalize?: NormalizeSettings;
}

/** A recipe whose tools and settings have been checked. */
export interface ParsedRecipe {
  /** Tool ids in run order. Ids this build does not know are kept and skipped by the runner. */
  tools: string[];
  settings: RecipeSettings;
}

export type ParseRecipeResult =
  | { ok: true; recipe: ParsedRecipe }
  | {
      ok: false;
      /** Dotted paths of the fields that are wrong, e.g. `compress.dpi`. */ problems: string[];
    };

const POSITIONS: readonly WatermarkPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
];
const ALIGNS: readonly HeaderFooterAlign[] = ['left', 'center', 'right'];
const LAYOUTS: readonly NUpLayout[] = ['2-up', '4-up', 'booklet'];
const PAPER_SIZES: readonly PaperSize[] = ['A4', 'Letter', 'Legal'];
const SCALE_MODES: readonly ScaleMode[] = ['fit', 'fill', 'center'];
/** The worker strips one leading `#` and reads six hex digits. */
const HEX_COLOUR = /^#?[0-9a-f]{6}$/i;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads typed fields out of one untrusted object, recording each bad one under
 * `prefix`. Every reader returns a placeholder on failure; the caller discards
 * the whole slice when `problems` grew, so a placeholder never reaches a tool.
 */
class Reader {
  constructor(
    private readonly source: Obj,
    private readonly prefix: string,
    private readonly problems: string[]
  ) {}

  private bad(key: string): void {
    this.problems.push(`${this.prefix}.${key}`);
  }

  number(key: string, min = -Infinity, max = Infinity): number {
    const v = this.source[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v;
    this.bad(key);
    return 0;
  }

  string(key: string, pattern?: RegExp): string {
    const v = this.source[key];
    if (typeof v === 'string' && (!pattern || pattern.test(v))) return v;
    this.bad(key);
    return '';
  }

  boolean(key: string): boolean {
    const v = this.source[key];
    if (typeof v === 'boolean') return v;
    this.bad(key);
    return false;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const v = this.source[key];
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    this.bad(key);
    return allowed[0];
  }

  image(key: string): WatermarkImage | null {
    const v = this.source[key];
    if (v === null || v === undefined) return null;
    // A JSON export turns `Uint8Array` into a plain object of indices, so an
    // image watermark does not survive export/import — say so, rather than
    // handing the worker something that is not image bytes.
    if (!isObject(v) || !(v.bytes instanceof Uint8Array)) {
      this.bad(key);
      return null;
    }
    const r = new Reader(v, `${this.prefix}.${key}`, this.problems);
    return {
      bytes: v.bytes,
      format: r.oneOf('format', ['png', 'jpeg'] as const),
      width: r.number('width', 1),
      height: r.number('height', 1),
      name: r.string('name')
    };
  }
}

function readCompress(r: Reader): CompressSettings {
  return { dpi: r.number('dpi', 1, 2400), quality: r.number('quality', 0, 1) };
}

function readWatermark(r: Reader): WatermarkSettings {
  return {
    kind: r.oneOf('kind', ['text', 'image'] as const),
    text: r.string('text'),
    image: r.image('image'),
    imageScale: r.number('imageScale', 0, 1),
    position: r.oneOf('position', POSITIONS),
    opacity: r.number('opacity', 0, 1),
    rotation: r.number('rotation', -360, 360),
    fontSize: r.number('fontSize', 1, 1000),
    color: r.string('color', HEX_COLOUR),
    startAt: r.number('startAt'),
    pageRange: r.string('pageRange')
  };
}

function readHeaderFooter(r: Reader): HeaderFooterSettings {
  return {
    headerText: r.string('headerText'),
    headerAlign: r.oneOf('headerAlign', ALIGNS),
    footerText: r.string('footerText'),
    footerAlign: r.oneOf('footerAlign', ALIGNS),
    fontSize: r.number('fontSize', 1, 1000),
    pageRange: r.string('pageRange')
  };
}

function readNUp(r: Reader): NUpSettings {
  return {
    layout: r.oneOf('layout', LAYOUTS),
    margin: r.number('margin', 0),
    gutter: r.number('gutter', 0),
    drawBorders: r.boolean('drawBorders')
  };
}

function readNormalize(r: Reader): NormalizeSettings {
  return {
    targetSize: r.oneOf('targetSize', PAPER_SIZES),
    scaleMode: r.oneOf('scaleMode', SCALE_MODES)
  };
}

/** Checks a stored recipe's `tools` and `settings`; see the module comment for the rules. */
export function parseRecipe(raw: { tools: unknown; settings: unknown }): ParseRecipeResult {
  const problems: string[] = [];

  let tools: string[] = [];
  if (Array.isArray(raw.tools) && raw.tools.every((t): t is string => typeof t === 'string')) {
    tools = [...raw.tools];
  } else {
    problems.push('tools');
  }

  const settings: RecipeSettings = {};
  if (raw.settings === undefined || raw.settings === null) {
    // No settings at all: every tool the recipe lists is unconfigured, which
    // the runner already reports as "missing settings".
  } else if (!isObject(raw.settings)) {
    problems.push('settings');
  } else {
    const source = raw.settings;
    const assign = <K extends keyof RecipeSettings>(
      key: K,
      read: (r: Reader) => RecipeSettings[K]
    ): void => {
      const value = source[key];
      if (value === undefined || value === null) return;
      if (!isObject(value)) {
        problems.push(key);
        return;
      }
      const before = problems.length;
      const parsed = read(new Reader(value, key, problems));
      if (problems.length === before) settings[key] = parsed;
    };
    assign('compress', readCompress);
    assign('watermark', readWatermark);
    assign('headerFooter', readHeaderFooter);
    assign('nup', readNUp);
    assign('normalize', readNormalize);
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, recipe: { tools, settings } };
}
